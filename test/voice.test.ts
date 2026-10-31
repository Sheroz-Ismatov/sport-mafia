import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Room } from '../server/room.ts';
import type { Member } from '../server/room.ts';
import { Voice, signToken, voiceConfigFromEnv } from '../server/voice.ts';
import type { ServerMessage } from '../server/protocol.ts';

const CFG = { url: 'wss://demo.livekit.cloud', apiKey: 'APIkey', apiSecret: 'secret-secret-secret' };
const FAST = {
  speechMs: 150, reducedSpeechMs: 80, mutedTurnMs: 50, lastWordMs: 100, dogovorkaMs: 60,
  voteWindowMs: 60, shootMs: 60, checkMs: 40, bestMoveMs: 60, dealTurnMs: 15,
};

function decode(token: string): { header: any; payload: any; valid: boolean } {
  const [h, p, s] = token.split('.');
  const valid = createHmac('sha256', CFG.apiSecret).update(`${h}.${p}`).digest('base64url') === s;
  return { header: JSON.parse(Buffer.from(h, 'base64url').toString()), payload: JSON.parse(Buffer.from(p, 'base64url').toString()), valid };
}

type Call = { url: string; auth: string; body: any };

function mockFetch(status = 200) {
  const calls: Call[] = [];
  let code = status;
  const fetch = async (url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ url, auth: init.headers.authorization, body: JSON.parse(init.body) });
    await new Promise((r) => setTimeout(r, 5));
    return { ok: code === 200, status: code, text: async () => '' };
  };
  return { calls, fetch, setStatus: (s: number) => { code = s; } };
}

const settle = () => new Promise((r) => setTimeout(r, 40));

function waitFor(check: () => boolean, ms = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() - started > ms) return reject(new Error('Не дождались'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

test('пропуск LiveKit: подпись HS256 и права', () => {
  const t = signToken(CFG, { sub: 'abc', video: { room: 'MAF-1', roomJoin: true, canPublish: false } }, 60, 1000);
  const { header, payload, valid } = decode(t);
  assert.equal(valid, true);
  assert.equal(header.alg, 'HS256');
  assert.equal(payload.iss, 'APIkey');
  assert.equal(payload.sub, 'abc');
  assert.equal(payload.exp, 1060);
  assert.equal(payload.video.canPublish, false);
});

test('голос включается только при всех трёх переменных окружения', () => {
  assert.equal(voiceConfigFromEnv({}), null);
  assert.equal(voiceConfigFromEnv({ LIVEKIT_URL: 'wss://x', LIVEKIT_API_KEY: 'k' }), null);
  assert.deepEqual(voiceConfigFromEnv({ LIVEKIT_URL: ' wss://x ', LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 's' }), { url: 'wss://x', apiKey: 'k', apiSecret: 's' });
});

test('права меняются только у подключившихся и только при изменении', async () => {
  const m = mockFetch();
  const voice = new Voice(CFG, { fetch: m.fetch, log: () => {} });

  voice.setAllowed('MAF-1', 'p1', true); // к голосу не подключался: ничего не шлём
  await settle();
  assert.equal(m.calls.length, 0);

  const pass = voice.join('MAF-1', 'p1', 'Аня', false);
  assert.equal(pass.url, CFG.url);
  assert.equal(decode(pass.token).payload.video.canPublish, false);
  voice.setAllowed('MAF-1', 'p1', true); // пропуск выдан, но браузер ещё не подключился
  await settle();
  assert.equal(m.calls.length, 0);

  voice.joined('MAF-1', 'p1'); // подключился: сверяем права
  await settle();
  assert.equal(m.calls.length, 1);
  const call = m.calls[0];
  assert.equal(call.url, 'https://demo.livekit.cloud/twirp/livekit.RoomService/UpdateParticipant');
  assert.deepEqual(call.body, { room: 'MAF-1', identity: 'p1', permission: { canSubscribe: true, canPublish: true, canPublishData: false } });
  const admin = decode(call.auth.replace('Bearer ', ''));
  assert.equal(admin.valid, true);
  assert.deepEqual(admin.payload.video, { room: 'MAF-1', roomAdmin: true });

  voice.setAllowed('MAF-1', 'p1', true); // без изменений: запроса нет
  await settle();
  assert.equal(m.calls.length, 1);

  // Быстрая смена туда и обратно: последнее значение побеждает
  voice.setAllowed('MAF-1', 'p1', false);
  voice.setAllowed('MAF-1', 'p1', true);
  voice.setAllowed('MAF-1', 'p1', false);
  await waitFor(() => voice.idle());
  await settle();
  assert.equal(m.calls.at(-1)!.body.permission.canPublish, false);

  // Участник ушёл из голоса (404): больше не дёргаем LiveKit, пока не вернётся
  m.setStatus(404);
  voice.setAllowed('MAF-1', 'p1', true);
  await settle();
  const n = m.calls.length;
  voice.setAllowed('MAF-1', 'p1', false);
  voice.setAllowed('MAF-1', 'p1', true);
  await settle();
  assert.equal(m.calls.length, n);
  m.setStatus(200);
  voice.joined('MAF-1', 'p1');
  await settle();
  assert.equal(m.calls.length, n + 1);
  assert.equal(m.calls.at(-1)!.body.permission.canPublish, true);
});

test('кто может говорить: лобби, раздача, речь, ночь, наблюдатель', async () => {
  const m = mockFetch();
  const voice = new Voice(CFG, { fetch: m.fetch, log: () => {} });
  const room = new Room('MAF-7', { settings: FAST, voice, botDelayMs: [1, 3] });
  const sent = new Map<string, ServerMessage[]>();
  const connect = (x: Member) => {
    sent.set(x.id, []);
    room.connect(x, (msg) => sent.get(x.id)!.push(msg));
  };
  const host = room.addMember('Ведущий', 'host');
  room.ownerToken = host.token;
  connect(host);
  const people = Array.from({ length: 6 }, (_, i) => room.addMember(`Игрок ${i + 1}`, 'player'));
  people.forEach(connect);
  const fan = room.addMember('Зритель', 'spectator');
  connect(fan);

  // Лобби: говорят ведущий и все игроки, зритель только слушает
  assert.equal(room.canSpeak(host), true);
  assert.ok(people.every((p) => room.canSpeak(p)));
  assert.equal(room.canSpeak(fan), false);

  // Пропуск приходит отдельным сообщением, права в нём по правилам
  assert.equal(room.handle(fan, { t: 'voice' }), null);
  const fanPass = sent.get(fan.id)!.find((x) => x.t === 'voice');
  assert.ok(fanPass && fanPass.t === 'voice');
  assert.equal(decode(fanPass.token).payload.video.canPublish, false);
  assert.equal(decode(fanPass.token).payload.sub, fan.id);

  // Все игроки подключаются к голосу
  for (const p of people) {
    room.handle(p, { t: 'voice' });
    room.handle(p, { t: 'voiceJoined' });
  }
  await waitFor(() => voice.idle());

  assert.equal(room.handle(host, { t: 'start' }), null);
  // Ведущий объявляет этапы: жмёт «Дальше», когда игра ждёт его
  const pilot = setInterval(() => {
    const g = room.game;
    if (g && g.phase !== 'ended' && (g.hold || (g.timer?.soft && (g.timer.endsAt ?? 0) <= Date.now()))) {
      room.handle(host, { t: 'act', action: { type: 'next' } });
    }
  }, 10);
  // Раздача и договорка: молчат все игроки
  assert.ok(people.every((p) => !room.canSpeak(p)));
  assert.equal(room.canSpeak(host), true);

  await waitFor(() => room.game!.phase === 'day' && room.game!.speaker !== null);
  const speaker = room.game!.speaker!;
  const talker = people.find((p) => room.seatOf(p) === speaker)!;
  assert.deepEqual(people.filter((p) => room.canSpeak(p)), [talker]);
  // Состояние для игрока говорит ему, открыт ли микрофон
  const last = sent.get(talker.id)!.filter((x) => x.t === 'state').at(-1);
  assert.ok(last && last.t === 'state' && last.room.you.mic === true && last.room.voice === true);

  // LiveKit получил: говорящему открыть, остальным закрыть
  await waitFor(() => voice.idle());
  await settle();
  const latest = new Map<string, boolean>();
  for (const c of m.calls) latest.set(c.body.identity, c.body.permission.canPublish);
  assert.equal(latest.get(talker.id), true);
  for (const p of people) if (p !== talker) assert.equal(latest.get(p.id) ?? false, false);

  // Ночь: молчат все, кроме ведущего
  await waitFor(() => room.game!.phase === 'night', 20_000);
  assert.ok(people.every((p) => !room.canSpeak(p)));
  assert.equal(room.canSpeak(host), true);
  clearInterval(pilot);
  room.close('конец теста');
});

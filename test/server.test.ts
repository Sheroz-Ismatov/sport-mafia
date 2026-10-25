import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { startServer } from '../server/index.ts';
import type { ClientMessage, ServerMessage } from '../server/protocol.ts';
import type { GameView } from '../engine/index.ts';

// Быстрые таймеры, чтобы партия шла секунды, а не час
const FAST = {
  speechMs: 120, reducedSpeechMs: 80, mutedTurnMs: 50, lastWordMs: 80, dogovorkaMs: 150,
  voteWindowMs: 60, shootMs: 120, checkMs: 80, bestMoveMs: 100, dealTurnMs: 40,
};

class Client {
  ws: WebSocket;
  messages: ServerMessage[] = [];
  token = '';
  code = '';
  last: Extract<ServerMessage, { t: 'state' }> | null = null;
  errors: string[] = [];
  onState: ((c: Client) => void) | null = null;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as ServerMessage;
      this.messages.push(msg);
      if (msg.t === 'welcome') {
        this.token = msg.token;
        this.code = msg.code;
      }
      if (msg.t === 'error') this.errors.push(msg.message);
      if (msg.t === 'state') {
        this.last = msg;
        this.onState?.(this);
      }
    });
  }

  open(): Promise<void> {
    return new Promise((r) => this.ws.once('open', () => r()));
  }

  send(msg: ClientMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  get game(): GameView | null {
    return this.last?.game ?? null;
  }
}

function waitFor(check: () => boolean, ms = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() - started > ms) return reject(new Error('Не дождались'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

/** Игрок-автомат: ходит только по тому, что пришло ему в GameView. */
function autoplay(c: Client): void {
  const g = c.game;
  if (g?.deal && g.deal.turn === g.mySeat && !g.me) {
    c.send({ t: 'act', action: { type: 'pickCard', index: g.deal.takenBy.indexOf(null) } });
    return;
  }
  if (!g || !g.me || !g.me.alive || g.phase === 'ended') return;
  const me = g.me.seat;
  const alive = g.seats.filter((s) => s.alive).map((s) => s.seat);
  const others = alive.filter((n) => n !== me);
  const act = (action: ClientMessage & { t: 'act' }) => c.send(action);

  if (g.phase === 'zeroNight' && g.me.role === 'don' && g.mafia && g.mafia.plan.length === 0) {
    const reds = g.seats.filter((s) => s.role === null).map((s) => s.seat);
    act({ t: 'act', action: { type: 'setPlan', plan: reds.slice(0, 3) } });
  }
  if (g.phase === 'day' && g.speaker === me) {
    const free = others.filter((n) => !g.nominations.some((x) => x.target === n));
    if (!g.nominations.some((x) => x.by === me) && free.length && me % 2 === 0) {
      act({ t: 'act', action: { type: 'nominate', target: free[me % free.length] } });
    }
    act({ t: 'act', action: { type: 'pass' } });
  }
  if ((g.phase === 'tieSpeech' || g.phase === 'lastWord') && g.speaker === me) act({ t: 'act', action: { type: 'pass' } });
  if (g.phase === 'voting' && g.voting && !(me in g.voting.votes) && me % 3 === 0) {
    act({ t: 'act', action: { type: 'vote', target: g.voting.candidates[g.voting.index] } });
  }
  if (g.phase === 'night' && g.nightStep === 'shoot' && g.me.team === 'black' && g.myShot === null) {
    const planned = g.mafia?.planTargetTonight;
    const target = planned && alive.includes(planned)
      ? planned
      : Math.min(...alive.filter((n) => g.seats[n - 1].role === null));
    act({ t: 'act', action: { type: 'shoot', target } });
  }
  const checkedTonight = g.myChecks.some((x) => x.night === g.night);
  if (g.phase === 'night' && !checkedTonight
    && ((g.nightStep === 'don' && g.me.role === 'don') || (g.nightStep === 'sheriff' && g.me.role === 'sheriff'))) {
    act({ t: 'act', action: { type: 'check', target: others[g.night % others.length] } });
  }
  if (g.phase === 'night' && g.nightStep === 'bestMove' && g.bestMoveBy === me) {
    act({ t: 'act', action: { type: 'bestMove', seats: others.slice(0, 3) } });
  }
}

test('целая партия по сети: ведущий, 10 игроков и наблюдатель', async () => {
  const srv = await startServer({ port: 0, settings: FAST, gamesFile: null });
  const url = `ws://localhost:${(srv.server.address() as AddressInfo).port}`;
  try {
    const host = new Client(url);
    await host.open();
    host.send({ t: 'create', nick: 'Ведущий' });
    await waitFor(() => host.code !== '');

    const players = Array.from({ length: 10 }, () => new Client(url));
    await Promise.all(players.map((p) => p.open()));
    players.forEach((p, i) => p.send({ t: 'join', code: host.code, nick: `Игрок ${i + 1}`, as: 'player' }));
    const spectator = new Client(url);
    await spectator.open();
    spectator.send({ t: 'join', code: host.code.toLowerCase(), nick: 'Зритель', as: 'spectator' });

    await waitFor(() => host.last?.room.players === 10 && host.last.room.spectators === 1);

    // 11-й игрок не помещается и становится зрителем
    const extra = new Client(url);
    await extra.open();
    extra.send({ t: 'join', code: host.code, nick: 'Игрок 1', as: 'player' });
    await waitFor(() => extra.last !== null);
    assert.equal(extra.last!.room.you.kind, 'spectator');
    assert.notEqual(extra.last!.room.members.find((m) => m.id === extra.last!.room.you.id)!.nick, 'Игрок 1', 'ник не дублируется');

    // Игрок не может начать игру, а наблюдатель — действовать
    players[0].send({ t: 'start' });
    await waitFor(() => players[0].errors.length > 0);

    for (const p of players) p.onState = autoplay;
    host.send({ t: 'start' });
    await waitFor(() => spectator.game?.phase === 'zeroNight');
    spectator.send({ t: 'act', action: { type: 'pass' } });
    await waitFor(() => spectator.errors.some((e) => e.includes('Наблюдатели')));

    // У каждого игрока своя роль, ведущий видит все
    const roles = players.map((p) => p.game!.me!.role);
    assert.equal(roles.filter((r) => r === 'civilian').length, 6);
    assert.ok(host.game!.seats.every((s) => s.role !== null));

    // Обрыв связи и возвращение по токену
    const leaver = players[7];
    const seat = leaver.game!.me!.seat;
    leaver.ws.close();
    await waitFor(() => host.last!.room.members.some((m) => m.seat === seat && !m.connected));
    const back = new Client(url);
    await back.open();
    back.onState = autoplay;
    back.send({ t: 'resume', code: leaver.code, token: leaver.token });
    await waitFor(() => back.game?.me?.seat === seat);
    players[7] = back;

    // Ведущий выдаёт фол
    host.send({ t: 'act', action: { type: 'foul', seat: 1, delta: 1 } });
    await waitFor(() => spectator.game!.seats[0].fouls === 1);

    await waitFor(() => host.game?.phase === 'ended', 60_000);
    const end = spectator.game!;
    assert.ok(end.winner, 'есть победитель');
    assert.ok(end.seats.every((s) => s.role !== null), 'после игры роли открыты всем');

    // Пока шла игра, наблюдатель не получил ни одной роли и ни одной ночной тайны
    const during = spectator.messages
      .filter((m): m is Extract<ServerMessage, { t: 'state' }> => m.t === 'state')
      .filter((m) => m.game && m.game.phase !== 'ended');
    assert.ok(during.length > 20);
    for (const m of during) {
      const g = m.game!;
      assert.ok(g.seats.every((s) => s.role === null), 'наблюдатель видит роль');
      assert.equal(g.mafia, null);
      assert.equal(g.host, null);
      assert.deepEqual(g.myChecks, []);
      assert.ok(!g.log.some((e) => /Проверка|стреляет|План|Роли:|убивает/.test(e.text)), 'тайна в протоколе');
    }
    // Мирный игрок тоже не знает чужих ролей
    const civilian = players.find((p) => p.game!.me!.role === 'civilian')!;
    const civStates = civilian.messages.filter((m) => m.t === 'state' && m.game && !['ended', 'deal'].includes(m.game.phase)) as Extract<ServerMessage, { t: 'state' }>[];
    for (const m of civStates) {
      assert.equal(m.game!.seats.filter((s) => s.role !== null).length, 1);
    }
    console.log(`Партия окончена: ${end.endReason}. Дней: ${end.day}, ночей: ${end.night}`);
  } finally {
    await srv.close();
  }
});

test('ведущий с ботами: партия доходит до конца сама', async () => {
  const srv = await startServer({ port: 0, settings: FAST, botDelayMs: [5, 20], gamesFile: null });
  const url = `ws://localhost:${(srv.server.address() as AddressInfo).port}`;
  try {
    const host = new Client(url);
    await host.open();
    host.send({ t: 'create', nick: 'Лео' });
    await waitFor(() => host.code !== '');
    host.send({ t: 'start' });
    await waitFor(() => host.errors.some((e) => e.includes('из 10')));
    host.send({ t: 'addBots' });
    await waitFor(() => host.last?.room.players === 10);
    host.send({ t: 'start' });
    await waitFor(() => host.game?.phase === 'ended', 60_000);
    assert.ok(host.game!.winner);
  } finally {
    await srv.close();
  }
});

test('комната без ведущего: создатель играет сам, потом новая партия', async () => {
  const srv = await startServer({ port: 0, settings: FAST, botDelayMs: [5, 20], gamesFile: null });
  const url = `ws://localhost:${(srv.server.address() as AddressInfo).port}`;
  try {
    const me = new Client(url);
    await me.open();
    me.onState = autoplay;
    me.send({ t: 'create', nick: 'Лео', as: 'player' });
    await waitFor(() => me.last !== null);
    assert.equal(me.last!.room.you.kind, 'player');
    assert.equal(me.last!.room.you.owner, true);
    assert.equal(me.last!.room.hostless, true);

    // Чужой игрок не может начать или добавить ботов
    const other = new Client(url);
    await other.open();
    other.send({ t: 'join', code: me.code, nick: 'Аня', as: 'player' });
    await waitFor(() => other.last !== null);
    other.send({ t: 'addBots' });
    await waitFor(() => other.errors.some((e) => e.includes('создатель')));
    other.send({ t: 'leave' });

    me.send({ t: 'addBots' });
    await waitFor(() => me.last?.room.players === 10);
    me.send({ t: 'start' });
    await waitFor(() => me.game?.phase === 'deal');
    const firstDeal = me.messages.find((m) => m.t === 'state' && m.game?.phase === 'deal') as Extract<ServerMessage, { t: 'state' }>;
    assert.equal(firstDeal.game!.me, null, 'до своей карты роли нет');
    assert.deepEqual(firstDeal.game!.deal, { turn: 1, takenBy: Array(10).fill(null) });
    await waitFor(() => me.game?.me !== null && me.game?.me !== undefined);
    await waitFor(() => me.game?.phase === 'ended', 60_000);

    me.send({ t: 'restart' });
    await waitFor(() => me.last?.game === null);
    assert.equal(me.last!.room.players, 10);
    me.send({ t: 'start' });
    await waitFor(() => me.game?.phase === 'deal');
  } finally {
    await srv.close();
  }
});

test('несуществующая комната и мусор вместо JSON', async () => {
  const srv = await startServer({ port: 0, gamesFile: null });
  const url = `ws://localhost:${(srv.server.address() as AddressInfo).port}`;
  try {
    const c = new Client(url);
    await c.open();
    c.ws.send('не json');
    c.send({ t: 'join', code: 'MAF-0000', nick: 'X', as: 'player' });
    c.send({ t: 'join', code: 'MAF-0000', nick: '   ', as: 'player' });
    await waitFor(() => c.errors.length >= 2);
    assert.deepEqual(c.errors.slice(0, 2), ['Неверное сообщение', 'Комната не найдена']);
  } finally {
    await srv.close();
  }
});

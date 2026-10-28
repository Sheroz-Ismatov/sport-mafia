// Вход через Telegram, место за столом по аккаунту и сохранение партии в базу.
// С TEST_DATABASE_URL работает на настоящем Postgres, без неё на простой базе в памяти.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { startServer } from '../server/index.ts';
import { PgDb } from '../server/db.ts';
import type { Db, GameRecord, Stats, User } from '../server/db.ts';
import type { ServerMessage } from '../server/protocol.ts';

const TG = { botToken: '777:secret', botUsername: 'mafia_test_bot', appName: 'play' };
const FAST = {
  speechMs: 40, reducedSpeechMs: 30, mutedTurnMs: 20, lastWordMs: 30, dogovorkaMs: 40,
  voteWindowMs: 20, shootMs: 30, checkMs: 20, bestMoveMs: 30, dealTurnMs: 10,
};

class MemoryDb implements Db {
  users: User[] = [];
  games: GameRecord[] = [];
  async upsertUser(u: { tgId: number; firstName: string; lastName: string | null; username: string | null; photoUrl: string | null }) {
    let x = this.users.find((y) => y.tgId === u.tgId);
    if (!x) this.users.push((x = { id: this.users.length + 1, ...u }));
    else Object.assign(x, u);
    return { ...x };
  }
  async getUser(id: number) { return this.users.find((u) => u.id === id) ?? null; }
  async saveGame(g: GameRecord) { this.games.push(g); return this.games.length; }
  async stats(userId: number): Promise<Stats> {
    const mine = this.games.flatMap((g) => g.players.filter((p) => p.userId === userId).map((p) => ({ g, p })));
    const clean = mine.filter((x) => x.g.bots === 0);
    const roles = { civilian: { games: 0, wins: 0 }, sheriff: { games: 0, wins: 0 }, mafia: { games: 0, wins: 0 }, don: { games: 0, wins: 0 } };
    for (const { p } of clean) { roles[p.role as 'don'].games++; if (p.won) roles[p.role as 'don'].wins++; }
    return { games: clean.length, wins: clean.filter((x) => x.p.won).length, draws: 0, roles, fouls: 0, removed: 0,
      hosted: this.games.filter((g) => g.hostUserId === userId).length, withBots: mine.length - clean.length, recent: [] };
  }
  async close() {}
}

function initData(id: number, name: string, startParam?: string): string {
  const fields: Record<string, string> = { user: JSON.stringify({ id, first_name: name }), auth_date: String(Math.floor(Date.now() / 1000)) };
  if (startParam) fields.start_param = startParam;
  const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(TG.botToken).digest();
  return new URLSearchParams({ ...fields, hash: createHmac('sha256', secret).update(check).digest('hex') }).toString();
}

function client(url: string) {
  const ws = new WebSocket(url);
  const msgs: ServerMessage[] = [];
  ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
  const last = () => [...msgs].reverse().find((m) => m.t === 'state') as Extract<ServerMessage, { t: 'state' }> | undefined;
  return { ws, msgs, last, open: () => new Promise<void>((r) => ws.once('open', () => r())), send: (m: object) => ws.send(JSON.stringify(m)) };
}

function waitFor(check: () => boolean, ms = 20_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => (check() ? resolve() : Date.now() - t0 > ms ? reject(new Error('Не дождались')) : setTimeout(tick, 10));
    tick();
  });
}

test('аккаунты: вход, место по аккаунту, партия в статистике', async () => {
  const db: Db = process.env.TEST_DATABASE_URL ? await PgDb.connect(process.env.TEST_DATABASE_URL) : new MemoryDb();
  const srv = await startServer({ port: 0, settings: FAST, botDelayMs: [2, 6], gamesFile: null, telegram: TG, db });
  const base = `http://localhost:${(srv.server.address() as AddressInfo).port}`;
  try {
    const cfg = await (await fetch(`${base}/api/config`)).json();
    assert.deepEqual(cfg, { telegram: { bot: 'mafia_test_bot', app: 'play', inline: false }, accounts: true });

    // Подделанные данные не пускают
    const bad = await fetch(`${base}/api/auth`, { method: 'POST', body: JSON.stringify({ initData: initData(1, 'Лео').replace('hash=', 'hash=00') }) });
    assert.equal(bad.status, 400);

    const tgId = 500_000_000 + Math.floor(Math.random() * 1e6);
    const auth = await (await fetch(`${base}/api/auth`, { method: 'POST', body: JSON.stringify({ initData: initData(tgId, 'Лео', 'MAF-1234') }) })).json();
    assert.equal(auth.user.firstName, 'Лео');
    assert.equal(auth.startParam, 'MAF-1234');
    const me0 = await (await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${auth.session}` } })).json();
    assert.equal(me0.user.id, auth.user.id);
    assert.equal(me0.stats.games, 0);
    assert.equal((await fetch(`${base}/api/me`, { headers: { authorization: 'Bearer forged.token' } })).status, 401);

    // Ведущий-гость создаёт стол, Лео входит с аккаунтом
    const host = client(base.replace('http', 'ws'));
    await host.open();
    host.send({ t: 'create', nick: 'Ведущий' });
    await waitFor(() => !!host.last());
    const code = host.last()!.room.code;
    const leo = client(base.replace('http', 'ws'));
    await leo.open();
    leo.send({ t: 'join', code, nick: 'Лео', as: 'player', session: auth.session });
    await waitFor(() => !!leo.last());
    const leoId = leo.last()!.room.you.id;

    // Тот же аккаунт с другого устройства попадает на то же место, а не вторым игроком
    const phone = client(base.replace('http', 'ws'));
    await phone.open();
    phone.send({ t: 'join', code, nick: 'Лео с телефона', as: 'player', session: auth.session });
    await waitFor(() => !!phone.last());
    assert.equal(phone.last()!.room.you.id, leoId);
    assert.equal(phone.last()!.room.players, 1);

    // Пять людей-гостей добирают стол до 6, партия без ботов. Доигрывается по таймерам.
    for (let i = 0; i < 5; i++) {
      const g = client(base.replace('http', 'ws'));
      await g.open();
      g.send({ t: 'join', code, nick: `Гость ${i}`, as: 'player' });
    }
    await waitFor(() => host.last()!.room.players === 6);
    host.send({ t: 'start' });
    await waitFor(() => host.last()?.game?.phase === 'ended', 60_000);

    let me: any;
    for (let i = 0; i < 50; i++) {
      me = await (await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${auth.session}` } })).json();
      if (me.stats.games === 1) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(me.stats.games, 1);
    const role = host.last()!.game!.seats.find((s) => s.nick === 'Лео')!.role!;
    assert.equal(me.stats.roles[role].games, 1);
  } finally {
    await srv.close();
    await db.close();
  }
});

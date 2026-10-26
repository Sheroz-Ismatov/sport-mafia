// Нужен настоящий Postgres: TEST_DATABASE_URL=postgres://... npm test. Без него тест пропускается.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PgDb } from '../server/db.ts';
import type { GameRecord } from '../server/db.ts';

const url = process.env.TEST_DATABASE_URL;

test('база: игроки, партии и статистика', { skip: !url && 'нет TEST_DATABASE_URL' }, async () => {
  const db = await PgDb.connect(url!);
  try {
    // Чистая база для теста
    const tg = Math.floor(Math.random() * 1e9) + 1e9;
    const leo = await db.upsertUser({ tgId: tg, firstName: 'Лео', lastName: null, username: 'leo', photoUrl: 'https://x/1.jpg' });
    const again = await db.upsertUser({ tgId: tg, firstName: 'Леонид', lastName: 'К', username: 'leo', photoUrl: null });
    assert.equal(again.id, leo.id);
    assert.equal(again.firstName, 'Леонид');
    assert.equal(again.photoUrl, 'https://x/1.jpg'); // фото не стирается, если Telegram его не прислал
    const anya = await db.upsertUser({ tgId: tg + 1, firstName: 'Аня', lastName: null, username: null, photoUrl: null });
    assert.deepEqual(await db.getUser(leo.id), again);
    assert.equal(await db.getUser(-1), null);

    const players = (roles: string[], winner: string, ids: (number | null)[], bots = 0): GameRecord['players'] =>
      roles.map((role, i) => ({
        seat: i + 1, userId: ids[i] ?? null, nick: `p${i + 1}`, bot: i >= roles.length - bots, role,
        won: winner !== 'draw' && ((role === 'mafia' || role === 'don') ? winner === 'black' : winner === 'red'),
        fouls: i === 0 ? 2 : 0, out: i === 1 ? 'removed' : null,
      }));
    const six = ['don', 'civilian', 'sheriff', 'mafia', 'civilian', 'civilian'];
    // 1) Лео дон, чёрные выиграли, без ботов
    await db.saveGame({ room: 'MAF-1', startedAt: new Date(), winner: 'black', reason: '', hostUserId: null, bots: 0, log: [{ text: 'а' }], players: players(six, 'black', [leo.id, anya.id]) });
    // 2) Лео дон, красные выиграли
    await db.saveGame({ room: 'MAF-2', startedAt: null, winner: 'red', reason: '', hostUserId: null, bots: 0, log: [], players: players(six, 'red', [leo.id]) });
    // 3) Лео шериф, но с ботами: не в статистике
    await db.saveGame({ room: 'MAF-3', startedAt: null, winner: 'red', reason: '', hostUserId: null, bots: 3, log: [], players: players(['sheriff', ...six.slice(1)], 'red', [leo.id], 3) });
    // 4) Лео ведущий
    await db.saveGame({ room: 'MAF-4', startedAt: null, winner: 'draw', reason: '', hostUserId: leo.id, bots: 0, log: [], players: players(six, 'draw', [null, anya.id]) });

    const s = await db.stats(leo.id);
    assert.equal(s.games, 2);
    assert.equal(s.wins, 1);
    assert.deepEqual(s.roles.don, { games: 2, wins: 1 });
    assert.deepEqual(s.roles.sheriff, { games: 0, wins: 0 });
    assert.equal(s.fouls, 4);
    assert.equal(s.withBots, 1);
    assert.equal(s.hosted, 1);
    assert.equal(s.recent.length, 3);
    assert.equal(typeof s.recent[0].endedAt, 'string');
    assert.equal(typeof s.games, 'number');

    const a = await db.stats(anya.id);
    assert.equal(a.games, 2);
    assert.equal(a.draws, 1);
    assert.equal(a.removed, 2);
    assert.deepEqual(a.roles.civilian, { games: 2, wins: 0 });
  } finally {
    await db.close();
  }
});

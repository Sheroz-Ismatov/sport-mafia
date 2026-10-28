import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room, cleanGender } from '../server/room.ts';
import type { ServerMessage } from '../server/protocol.ts';
import { roleArt, seatArt } from '../client/src/art.ts';

test('пол игрока: парень, девушка, трансформер, мусор становится парнем', () => {
  assert.equal(cleanGender('f'), 'f');
  assert.equal(cleanGender('x'), 'x');
  assert.equal(cleanGender('m'), 'm');
  assert.equal(cleanGender('кот'), 'm');
  assert.equal(cleanGender(undefined), 'm');
});

test('рисунки карт: в лобби номеров нет, на старте у всех разные', () => {
  const room = new Room('MAF-1', { botDelayMs: [100000, 100000] });
  const owner = room.addMember('Лео', 'player', false, null, 'x');
  room.ownerToken = owner.token;
  let last: Extract<ServerMessage, { t: 'state' }> | null = null;
  room.connect(owner, (m) => { if (m.t === 'state') last = m; });
  room.handle(owner, { t: 'addBots' });
  assert.equal(last!.room.members.find((m) => m.id === owner.id)!.gender, 'x');
  assert.ok(last!.room.members.every((m) => m.art === null), 'до раздачи номеров нет');
  assert.equal(last!.room.members.find((m) => m.nick === 'Бот Аня')!.gender, 'f');

  room.handle(owner, { t: 'start' });
  const arts = last!.room.members.filter((m) => m.kind === 'player').map((m) => m.art);
  assert.deepEqual([...arts].sort((a, b) => a! - b!), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  room.close('конец теста');
});

test('колоды: мирные разные, девушкам пока коты, остальные роли одни', () => {
  const names = new Set([0, 1, 2, 3, 4, 5, 6].map((i) => roleArt('civilian', 'm', i)));
  assert.equal(names.size, 7);
  assert.equal(roleArt('civilian', 'f', 2), roleArt('civilian', 'm', 2));
  assert.equal(roleArt('don', 'x', 5), 'don');
  assert.equal(seatArt('civilian', 3, undefined), roleArt('civilian', 'm', 2));
});

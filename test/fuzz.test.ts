// Случайные партии со случайными действиями: движок не должен падать ни при каком порядке нажатий.
// Любая ошибка, кроме RuleError (обычный отказ по правилам), уронила бы сервер.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, viewFor, teamOf } from '../engine/index.ts';
import type { Action, Actor, Viewer } from '../engine/index.ts';

function rng(seed: number): () => number {
  // mulberry32: воспроизводимые случайные числа
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('500 случайных партий на 6-10 игроков: без падений, правила соблюдены', () => {
  let finished = 0;
  for (let gameNo = 0; gameNo < 500; gameNo++) {
    const r = rng(gameNo + 1);
    const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
    const size = int(6, 10);
    const g = new Game({}, r);
    let now = 0;
    const players = Array.from({ length: size }, (_, i) => ({ playerId: 'p' + i, nick: 'N' + i }));
    assert.ok(g.dispatch({ kind: 'host' }, { type: 'start', players }, now).ok);

    for (let step = 0; step < 4000 && g.phase !== 'ended'; step++) {
      now += int(1, 3000);
      const seat = int(0, size + 1); // иногда несуществующие места: 0 и size+1
      const actors: Actor[] = [{ kind: 'host' }, { kind: 'system' }, { kind: 'seat', seat }];
      const actor = actors[int(0, 2)];
      const n = () => int(-1, size + 2);
      const actions: Action[] = [
        { type: 'timeout' }, { type: 'timeout' }, { type: 'timeout' }, { type: 'next' },
        { type: 'pickCard', index: int(-1, size) },
        { type: 'pass' }, { type: 'nominate', target: n() }, { type: 'vote', target: n() }, { type: 'liftYes' },
        { type: 'setPlan', plan: [n(), n()] }, { type: 'setBeacon', beacon: int(0, 4) as 0 },
        { type: 'setPhrase', index: int(-1, 3) },
        { type: 'shoot', target: n() }, { type: 'check', target: n() }, { type: 'bestMove', seats: [n(), n(), n()] },
        { type: 'pause' }, { type: 'resume' }, { type: 'addTime', ms: int(-1000, 400_000) },
        { type: 'foul', seat: n(), delta: r() < 0.7 ? 1 : -1 },
      ];
      // Удаления и ППК редко, иначе партии заканчиваются сразу
      if (r() < 0.01) actions.push({ type: 'remove', seat: n() });
      if (r() < 0.002) actions.push({ type: 'ppk', seat: n() });
      const action = actions[int(0, actions.length - 1)];

      // dispatch бросает исключение только при настоящей ошибке в коде
      g.dispatch(actor, action, now);

      // Состояние всегда целое (phase как строка: после dispatch фаза могла смениться)
      const phase: string = g.phase;
      const alive = g.aliveSeats();
      if (phase !== 'deal' && phase !== 'lobby') {
        const blacks = alive.filter((s) => teamOf(g.seatOf(s).role) === 'black').length;
        if (phase !== 'ended' && phase !== 'lastWord') {
          assert.ok(blacks > 0 && blacks < alive.length - blacks, `партия ${gameNo}: победа не засчитана`);
        }
      }
      if (g.speaker !== null && g.phase === 'day') assert.ok(g.seatOf(g.speaker).alive);
      const viewers: Viewer[] = [{ kind: 'host' }, { kind: 'spectator' }, { kind: 'player', seat: int(1, size) }];
      const v = viewFor(g, viewers[int(0, 2)]);
      assert.equal(v.seats.length, size);
      if (v.as === 'spectator' && phase !== 'ended') assert.ok(v.seats.every((s) => s.role === null));
    }
    if (g.phase === 'ended') {
      finished++;
      assert.ok(g.winner, `партия ${gameNo}: конец без итога`);
    }
  }
  assert.ok(finished > 450, `закончились только ${finished} из 500`);
});

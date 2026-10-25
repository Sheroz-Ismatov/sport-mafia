import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, viewFor } from '../engine/index.ts';
import type { Action, Actor, Role } from '../engine/index.ts';

// Раскладка как на макетах: дон №5, мафия №3 и №8, шериф №10
const ROLES: Role[] = ['civilian', 'civilian', 'mafia', 'civilian', 'don', 'civilian', 'civilian', 'mafia', 'civilian', 'sheriff'];
const HOST: Actor = { kind: 'host' };
const SYS: Actor = { kind: 'system' };
const P = (seat: number): Actor => ({ kind: 'seat', seat });
const players = Array.from({ length: 10 }, (_, i) => ({ playerId: 'p' + (i + 1), nick: 'Игрок' + (i + 1) }));

function setup() {
  const g = new Game();
  let now = 1000;
  const act = (actor: Actor, action: Action) => {
    now += 10;
    const r = g.dispatch(actor, action, now);
    assert.ok(r.ok, r.ok ? '' : r.error);
  };
  const fails = (actor: Actor, action: Action, pattern?: RegExp) => {
    const r = g.dispatch(actor, action, ++now);
    assert.equal(r.ok, false, `ожидалась ошибка для ${JSON.stringify(action)}`);
    if (pattern && !r.ok) assert.match(r.error, pattern);
  };
  const next = () => act(HOST, { type: 'next' });
  const timeout = () => act(SYS, { type: 'timeout' });
  /** Все говорят «Пас», пока не закончится день. nominate: кто кого выставляет. */
  const day = (nominate: Record<number, number> = {}) => {
    assert.equal(g.phase, 'day');
    while (g.phase === 'day') {
      const s = g.speaker!;
      if (nominate[s] !== undefined) act(P(s), { type: 'nominate', target: nominate[s] });
      act(P(s), { type: 'pass' });
    }
  };
  /** Голосование: votes — кто против кого. Остальные не голосуют. */
  const vote = (votes: Record<number, number>) => {
    assert.equal(g.phase, 'voting');
    while (g.phase === 'voting') {
      const current = g.voting!.candidates[g.voting!.index];
      for (const [voter, target] of Object.entries(votes)) {
        if (target === current) act(P(Number(voter)), { type: 'vote', target });
      }
      timeout();
    }
  };
  const lastWords = () => { while (g.phase === 'lastWord') act(P(g.speaker!), { type: 'pass' }); };
  /** Ночь: выстрелы чёрных, затем шаги дона и шерифа по таймеру. */
  const night = (shots: Record<number, number>, checks: { don?: number; sheriff?: number } = {}) => {
    assert.equal(g.phase, 'night');
    assert.equal(g.nightStep, 'shoot');
    for (const [s, t] of Object.entries(shots)) act(P(Number(s)), { type: 'shoot', target: t });
    timeout();
    if (checks.don) act(P(5), { type: 'check', target: checks.don });
    timeout();
    if (checks.sheriff) act(P(10), { type: 'check', target: checks.sheriff });
    timeout();
    const step: string | null = g.nightStep;
    if (step === 'bestMove') timeout(); // убитый в первую ночь промолчал
  };
  const start = () => {
    act(HOST, { type: 'start', players, fixedSeats: true, roles: ROLES, instantDeal: true });
    act(P(5), { type: 'setPlan', plan: [6, 1] });
    timeout(); // договорка закончилась
  };
  return { g, act, fails, next, timeout, day, vote, lastWords, night, start };
}

test('раздача: 6 мирных, шериф, дон и 2 мафии; нужно ровно 10 игроков', () => {
  const g = new Game({}, () => 0.42);
  assert.equal(g.dispatch(HOST, { type: 'start', players: players.slice(0, 9) }, 0).ok, false);
  assert.ok(g.dispatch(HOST, { type: 'start', players, instantDeal: true }, 0).ok);
  const count = (r: Role) => g.seats.filter((s) => s.role === r).length;
  assert.deepEqual([count('civilian'), count('sheriff'), count('mafia'), count('don')], [6, 1, 2, 1]);
  assert.equal(g.phase, 'zeroNight');
});

test('раздача: по очереди с №1, 6 секунд на ход, минута на всех', () => {
  const g = new Game({}, () => 0.3);
  let now = 0;
  assert.ok(g.dispatch(HOST, { type: 'start', players, fixedSeats: true, roles: ROLES }, now).ok);
  assert.equal(g.phase, 'deal');
  assert.equal(g.dealTurn, 1);
  assert.equal(g.timer!.durationMs, 6000);

  // Не своя очередь и занятая карта
  assert.equal(g.dispatch(P(2), { type: 'pickCard', index: 0 }, now).ok, false);
  assert.ok(g.dispatch(P(1), { type: 'pickCard', index: 4 }, now).ok); // в колоде на месте 4 — дон
  assert.equal(g.seatOf(1).role, 'don');
  assert.equal(g.dispatch(P(1), { type: 'pickCard', index: 5 }, now).ok, false, 'вторую карту не взять');

  // Роль видна только взявшему и ведущему, чёрные пока не знают друг друга
  const me = viewFor(g, { kind: 'player', seat: 1 });
  assert.equal(me.me?.role, 'don');
  assert.equal(me.mafia, null);
  assert.equal(viewFor(g, { kind: 'player', seat: 2 }).seats[0].role, null);
  assert.equal(viewFor(g, { kind: 'player', seat: 2 }).me, null, 'у №2 ещё нет карты');
  assert.equal(viewFor(g, { kind: 'host' }).seats[0].role, 'don');
  assert.equal(viewFor(g, { kind: 'host' }).seats[1].role, null);
  assert.equal(g.dispatch(HOST, { type: 'foul', seat: 3, delta: 1 }, now).ok, false, 'фолы после раздачи');

  // Ход идёт полные 6 секунд, даже если карту уже взяли. Остальные не успели — карта выдаётся сама
  for (let i = 0; i < 10; i++) {
    now += 6000;
    assert.ok(g.dispatch(SYS, { type: 'timeout' }, now).ok);
  }
  assert.equal(now, 60_000);
  assert.equal(g.phase, 'zeroNight');
  assert.ok(g.seats.every((s) => s.dealtAt !== null));
  const count = (r: Role) => g.seats.filter((s) => s.role === r).length;
  assert.deepEqual([count('civilian'), count('sheriff'), count('mafia'), count('don')], [6, 1, 2, 1]);
  assert.deepEqual(viewFor(g, { kind: 'player', seat: 1 }).mafia?.members.length, 3, 'на договорке чёрные видят своих');
});

test('договорка: план задаёт только дон, видят только чёрные', () => {
  const { g, act, fails } = setup();
  act(HOST, { type: 'start', players, fixedSeats: true, roles: ROLES, instantDeal: true });
  fails(P(3), { type: 'setPlan', plan: [1] }, /дон/);
  act(P(5), { type: 'setPlan', plan: [6, 1] });
  act(P(5), { type: 'setBeacon', beacon: 2 });
  act(P(5), { type: 'setPhrase', index: 0 });
  fails(P(5), { type: 'setPlan', plan: [1, 1] }, /повторяются/);

  const mafia = viewFor(g, { kind: 'player', seat: 8 });
  assert.deepEqual(mafia.mafia?.plan, [6, 1]);
  assert.deepEqual(mafia.mafia?.members.map((m) => m.seat), [3, 5, 8]);
  assert.equal(mafia.seats[4].role, 'don');
  assert.equal(mafia.seats[9].role, null, 'мафия не знает шерифа');

  const civ = viewFor(g, { kind: 'player', seat: 1 });
  assert.equal(civ.mafia, null);
  assert.deepEqual(civ.seats.map((s) => s.role), ['civilian', null, null, null, null, null, null, null, null, null]);

  const spectator = viewFor(g, { kind: 'spectator' });
  assert.ok(spectator.seats.every((s) => s.role === null));
  const raw = JSON.stringify(spectator);
  for (const secret of ['"role":"don"', '"role":"mafia"', '"role":"sheriff"', '"role":"civilian"', 'План отстрела', 'Роли:']) {
    assert.ok(!raw.includes(secret), `наблюдатель видит ${secret}`);
  }
  assert.equal(viewFor(g, { kind: 'host' }).seats[9].role, 'sheriff');
});

test('очерёдность речей: день 1 с №1, день 2 со следующего после открывавшего', () => {
  const { g, start, day, night, lastWords } = setup();
  start();
  assert.equal(g.dayOpener, 1);
  assert.equal(g.speaker, 1);
  day();
  night({ 3: 6, 5: 6, 8: 6 });
  lastWords();
  assert.equal(g.day, 2);
  assert.equal(g.dayOpener, 2);
  assert.deepEqual(g.speechQueue, [3, 4, 5, 7, 8, 9, 10, 1]); // №6 убит, №2 уже говорит
});

test('выставление: только в свою минуту, одна кандидатура, без повторов', () => {
  const { g, act, fails, start } = setup();
  start();
  fails(P(2), { type: 'nominate', target: 4 }, /свою минуту/);
  act(P(1), { type: 'nominate', target: 4 });
  fails(P(1), { type: 'nominate', target: 5 }, /уже выставили/);
  act(P(1), { type: 'pass' });
  fails(P(2), { type: 'nominate', target: 4 }, /уже выставлен/);
  act(P(2), { type: 'nominate', target: 2 }); // себя можно
  assert.deepEqual(g.nominations.map((n) => n.target), [4, 2]);
});

test('в первый день одна кандидатура: голосования нет', () => {
  const { g, start, day } = setup();
  start();
  day({ 1: 4 });
  assert.equal(g.phase, 'night');
  assert.ok(g.seats.every((s) => s.alive));
});

test('голосование: кто не голосовал, уходит в последнего; уходит лидер и говорит минуту', () => {
  const { g, start, day, vote, lastWords } = setup();
  start();
  day({ 1: 3, 2: 9 });
  assert.deepEqual(g.voting!.candidates, [3, 9]);
  vote({ 1: 3, 2: 3, 4: 3, 6: 3, 7: 3 }); // 5 против №3, остальные 5 автоматически против №9
  // 5:5 — ничья, оправдания
  assert.equal(g.phase, 'tieSpeech');
  while (g.phase === 'tieSpeech') g.dispatch(P(g.speaker!), { type: 'pass' }, 5000);
  vote({ 1: 3, 2: 3, 4: 3, 6: 3, 7: 3, 9: 3 }); // теперь 6 против №3
  assert.equal(g.phase, 'lastWord');
  assert.equal(g.speaker, 3);
  assert.deepEqual(g.micOpen(), [3]);
  assert.equal(g.seatOf(3).out?.reason, 'voted');
  lastWords();
  assert.equal(g.phase, 'night');
});

test('попил дважды подряд: голосование за подъём обоих, лучший ход сгорает', () => {
  const { g, act, start, day, vote, lastWords, night } = setup();
  start();
  day({ 1: 3, 2: 9 });
  const split = { 1: 3, 2: 3, 4: 3, 6: 3, 7: 3 };
  vote(split);
  while (g.phase === 'tieSpeech') act(P(g.speaker!), { type: 'pass' });
  vote(split);
  assert.equal(g.phase, 'liftVote');
  for (const s of [1, 2, 4, 6, 7, 10]) act(P(s), { type: 'liftYes' }); // 6 из 10
  act(HOST, { type: 'next' });
  assert.equal(g.seatOf(3).alive, false);
  assert.equal(g.seatOf(9).alive, false);
  lastWords();
  night({ 5: 1, 8: 1 });
  assert.notEqual(g.nightStep, 'bestMove', '7.10: ушли двое, лучшего хода нет');
});

test('подъём без большинства: все остаются', () => {
  const { g, act, start, day, vote } = setup();
  start();
  day({ 1: 3, 2: 9 });
  const split = { 1: 3, 2: 3, 4: 3, 6: 3, 7: 3 };
  vote(split);
  while (g.phase === 'tieSpeech') act(P(g.speaker!), { type: 'pass' });
  vote(split);
  for (const s of [1, 2, 4, 6, 7]) act(P(s), { type: 'liftYes' }); // ровно половина
  act(HOST, { type: 'next' });
  assert.equal(g.phase, 'night');
  assert.ok(g.seatOf(3).alive && g.seatOf(9).alive);
});

test('ночь: промах, если чёрные выстрелили по-разному', () => {
  const { g, start, day, night } = setup();
  start();
  day();
  night({ 3: 6, 5: 6, 8: 1 });
  assert.equal(g.phase, 'day');
  assert.equal(g.aliveSeats().length, 10);
});

test('ночь: проверки видны только дону и шерифу, лучший ход открывается утром', () => {
  const { g, act, timeout, start, day, lastWords } = setup();
  start();
  day();
  for (const s of [3, 5, 8]) act(P(s), { type: 'shoot', target: 6 });
  timeout();
  act(P(5), { type: 'check', target: 10 });
  timeout();
  act(P(10), { type: 'check', target: 3 });
  timeout();
  assert.equal(g.nightStep, 'bestMove');
  assert.equal(viewFor(g, { kind: 'spectator' }).bestMove, null);
  act(P(6), { type: 'bestMove', seats: [3, 8, 9] });
  assert.equal(g.phase, 'lastWord');

  assert.deepEqual(viewFor(g, { kind: 'player', seat: 5 }).myChecks, [{ night: 1, target: 10, result: true }]);
  assert.deepEqual(viewFor(g, { kind: 'player', seat: 10 }).myChecks, [{ night: 1, target: 3, result: true }]);
  const civ = viewFor(g, { kind: 'player', seat: 1 });
  assert.deepEqual(civ.myChecks, []);
  assert.ok(!civ.log.some((e) => e.text.includes('Проверка')));
  assert.deepEqual(civ.bestMove, { by: 6, seats: [3, 8, 9] });
  assert.equal(g.seatOf(6).out?.reason, 'killed');
  lastWords();
  assert.equal(g.day, 2);
});

test('шаг шерифа идёт, даже если шериф уже выбыл (чтобы не выдать его)', () => {
  const { g, act, timeout, start, day, vote, lastWords } = setup();
  start();
  day({ 1: 10, 2: 4 });
  vote({ 1: 10, 2: 10, 3: 10, 4: 10, 5: 10, 6: 10 });
  lastWords();
  for (const s of [3, 5, 8]) act(P(s), { type: 'shoot', target: 1 });
  timeout();
  timeout();
  assert.equal(g.nightStep, 'sheriff');
  assert.ok(g.timer && g.timer.durationMs > 0);
});

test('фолы: 3-й лишает ближайшей речи, 4-й удаляет и отменяет голосование', () => {
  const { g, act, start, day } = setup();
  start();
  for (let i = 0; i < 3; i++) act(HOST, { type: 'foul', seat: 4, delta: 1 });
  assert.equal(g.seatOf(4).muteNextSpeech, true);
  act(P(1), { type: 'nominate', target: 9 });
  act(P(1), { type: 'pass' });
  act(P(2), { type: 'nominate', target: 3 });
  act(P(2), { type: 'pass' });
  act(P(3), { type: 'pass' });
  assert.equal(g.speaker, 4);
  assert.equal(g.speakerMuted, true);
  assert.deepEqual(g.micOpen(), [], 'микрофон молчащего закрыт');
  act(P(4), { type: 'pass' });
  act(HOST, { type: 'foul', seat: 4, delta: 1 });
  assert.equal(g.seatOf(4).out?.reason, 'removed');
  day();
  assert.equal(g.phase, 'night', '7.1: голосование дня отменено');
});

test('удаление говорящего передаёт слово следующему', () => {
  const { g, act, start } = setup();
  start();
  act(HOST, { type: 'remove', seat: 1 });
  assert.equal(g.speaker, 2);
  assert.ok(g.noVoteDays.has(1));
});

test('победа красных: вся мафия выведена', () => {
  const { g, start, day, vote, lastWords, night } = setup();
  start();
  day({ 1: 3, 2: 9 });
  vote({ 1: 3, 2: 3, 4: 3, 6: 3, 7: 3, 10: 3 });
  lastWords();
  night({ 5: 1, 8: 2 }); // промах
  day({ 1: 5, 2: 8 });
  vote({ 1: 5, 2: 5, 4: 5, 6: 5, 7: 5, 10: 5 });
  lastWords();
  night({ 8: 1 });
  lastWords();
  day({ 2: 8 });
  vote({});
  assert.equal(g.winner, 'red');
  lastWords();
  assert.equal(g.phase, 'ended');
  assert.ok(viewFor(g, { kind: 'spectator' }).seats.every((s) => s.role !== null), 'после игры роли открыты');
});

test('победа чёрных: чёрных столько же, сколько красных', () => {
  const { g, start, day, vote, lastWords, night } = setup();
  start();
  const kills = [1, 2, 4, 6, 7];
  // Каждый день город выгоняет красного, каждую ночь мафия убивает красного
  for (let round = 0; g.phase !== 'ended' && round < 5; round++) {
    const red = g.aliveSeats().find((n) => !g.isBlack(n) && n !== kills[round])!;
    const opener = g.speaker!;
    day({ [opener]: red });
    if (g.phase === 'voting') vote({});
    lastWords();
    if (g.phase !== 'night') break;
    night({ 3: kills[round], 5: kills[round], 8: kills[round] });
    lastWords();
  }
  assert.equal(g.winner, 'black');
  assert.equal(g.phase, 'ended');
});

test('ППК: команда нарушителя проигрывает сразу', () => {
  const { g, act, start } = setup();
  start();
  act(HOST, { type: 'ppk', seat: 8 });
  assert.equal(g.phase, 'ended');
  assert.equal(g.winner, 'red');
});

test('ничья: три ночи подряд никто не уходит', () => {
  const { g, start, day, night } = setup();
  start();
  for (let i = 0; i < 3; i++) {
    day();
    night({}); // мафия не стреляет
  }
  assert.equal(g.winner, 'draw');
  assert.equal(g.phase, 'ended');
});

test('пауза и добавление времени', () => {
  const { g, act, start } = setup();
  start();
  const before = g.timer!.endsAt!;
  act(HOST, { type: 'pause' });
  assert.equal(g.timer!.endsAt, null);
  act(HOST, { type: 'addTime', ms: 30_000 });
  act(HOST, { type: 'resume' });
  assert.ok(g.timer!.endsAt! > before + 29_000);
});

test('наблюдатель и чужие игроки не могут действовать за других', () => {
  const { g, fails, start } = setup();
  start();
  fails(P(1), { type: 'next' }, /ведущий/);
  fails(P(1), { type: 'timeout' }, /сервер/);
  fails(HOST, { type: 'pass' }, /игрока/);
  assert.equal(g.speaker, 1);
});

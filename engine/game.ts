// Игровой движок спортивной мафии. Чистая логика без сети и без настоящих таймеров:
// сервер передаёт текущее время в dispatch() и сам вызывает { type: 'timeout' },
// когда истекает timer.endsAt. Номера пунктов в комментариях — правила ФСМ.

import {
  DEFAULT_SETTINGS, SHERIFF_PHRASES, teamOf,
} from './types.ts';
import type {
  Action, ActionResult, Actor, CheckResult, LiftVote, LogAudience, LogEntry, MafiaPlan,
  NightStep, Nomination, OutReason, Phase, Role, Seat, Settings, Team, Timer, Voting, Winner,
} from './types.ts';

export class RuleError extends Error {}

function fail(message: string): never {
  throw new RuleError(message);
}

const ROLE_DECK: Role[] = [
  'civilian', 'civilian', 'civilian', 'civilian', 'civilian', 'civilian',
  'sheriff', 'mafia', 'mafia', 'don',
];

function shuffle<T>(items: T[], rng: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export class Game {
  settings: Settings;
  rng: () => number;
  now = 0;

  phase: Phase = 'lobby';
  day = 0;    // 0 — нулевая ночь, дальше День 1, День 2...
  night = 0;  // ночи со стрельбой: Ночь 1 идёт после Дня 1
  seats: Seat[] = [];
  timer: Timer | null = null;

  // раздача
  deck: Role[] = [];
  deckTakenBy: (number | null)[] = []; // карта i -> кто её взял
  dealTurn: number | null = null;      // чей сейчас ход тянуть карту

  // день
  dayOpener: number | null = null;
  speechQueue: number[] = [];
  speaker: number | null = null;
  speakerMuted = false;
  nominations: Nomination[] = [];
  noVoteDays = new Set<number>();

  // голосование
  voting: Voting | null = null;
  tieQueue: number[] = [];
  tieCandidates: number[] = [];
  liftVote: LiftVote | null = null;

  // последняя минута
  lastWordQueue: number[] = [];
  afterLastWord: 'night' | 'day' = 'night';

  // ночь
  nightStep: NightStep | null = null;
  shots: Record<number, number> = {};
  nightKill: number | null = null;
  donCheckedTonight = false;
  sheriffCheckedTonight = false;
  donChecks: CheckResult[] = [];
  sheriffChecks: CheckResult[] = [];
  bestMove: { by: number; seats: number[] } | null = null;
  bestMoveBlocked = false; // 7.10: в первый день ушли двое и больше
  mafiaPlan: MafiaPlan = { plan: [], beacon: 2, sheriffPhrase: 0 };

  // конец игры
  winner: Winner | null = null;
  endReason = '';
  stagnantNights = 0;     // 7.7: три ночи подряд без выбывших — ничья
  aliveAtLastMorning = 10;

  log: LogEntry[] = [];

  constructor(settings: Partial<Settings> = {}, rng: () => number = Math.random) {
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.rng = rng;
  }

  // ---------- Вход для всех действий ----------

  dispatch(actor: Actor, action: Action, now: number): ActionResult {
    this.now = now;
    try {
      this.handle(actor, action);
      return { ok: true };
    } catch (e) {
      if (e instanceof RuleError) return { ok: false, error: e.message };
      throw e;
    }
  }

  private handle(actor: Actor, action: Action): void {
    // Действия ведущего
    const hostOnly = ['start', 'next', 'pause', 'resume', 'addTime', 'foul', 'remove', 'ppk'];
    if (hostOnly.includes(action.type)) this.requireHost(actor);

    switch (action.type) {
      case 'start': return this.start(action.players, action.fixedSeats ?? false, action.roles, action.instantDeal ?? false);
      case 'next':
        this.requireRunning();
        return this.advance();
      case 'timeout':
        if (actor.kind !== 'system') fail('Таймер завершает только сервер');
        this.requireRunning();
        return this.advance();
      case 'pause': return this.pause();
      case 'resume': return this.resume();
      case 'addTime': return this.addTime(action.ms);
      case 'foul': return this.foul(action.seat, action.delta);
      case 'remove': return this.remove(action.seat, 'дисквалифицирующий фол');
      case 'ppk': return this.ppk(action.seat);
      // Действия игроков
      case 'pickCard': return this.pickCard(this.requireSeat(actor), action.index);
      case 'pass': return this.pass(this.requireSeat(actor));
      case 'nominate': return this.nominate(this.requireSeat(actor), action.target);
      case 'vote': return this.vote(this.requireSeat(actor), action.target);
      case 'liftYes': return this.liftYes(this.requireSeat(actor));
      case 'setPlan': return this.setPlan(this.requireSeat(actor), action.plan);
      case 'setBeacon': return this.setBeacon(this.requireSeat(actor), action.beacon);
      case 'setPhrase': return this.setPhrase(this.requireSeat(actor), action.index);
      case 'shoot': return this.shoot(this.requireSeat(actor), action.target);
      case 'check': return this.check(this.requireSeat(actor), action.target);
      case 'bestMove': return this.makeBestMove(this.requireSeat(actor), action.seats);
      default: fail('Неизвестное действие');
    }
  }

  // ---------- Помощники ----------

  private requireHost(actor: Actor): void {
    if (actor.kind !== 'host') fail('Это может сделать только ведущий');
  }

  private requireSeat(actor: Actor): number {
    if (actor.kind !== 'seat') fail('Это действие игрока');
    return actor.seat;
  }

  private requireRunning(): void {
    if (this.phase === 'lobby' || this.phase === 'ended') fail('Игра не идёт');
  }

  seatOf(n: number): Seat {
    const s = this.seats[n - 1];
    if (!s) fail(`Нет места №${n}`);
    return s;
  }

  isBlack(n: number): boolean {
    return teamOf(this.seatOf(n).role) === 'black';
  }

  aliveSeats(): number[] {
    return this.seats.filter((s) => s.alive).map((s) => s.seat);
  }

  private requireAlive(n: number): Seat {
    const s = this.seatOf(n);
    if (!s.alive) fail(`Игрок №${n} уже не в игре`);
    return s;
  }

  /** Живые места по кругу, начиная с from (включительно). */
  private circleFrom(from: number): number[] {
    const order: number[] = [];
    for (let i = 0; i < 10; i++) {
      const n = ((from - 1 + i) % 10) + 1;
      if (this.seatOf(n).alive) order.push(n);
    }
    return order;
  }

  private write(text: string, audience: LogAudience = 'public'): void {
    this.log.push({ at: this.now, day: this.day, night: this.night, text, audience });
  }

  private startTimer(ms: number): void {
    this.timer = { durationMs: ms, endsAt: this.now + ms, pausedRemainingMs: null };
  }

  private markOut(n: number, reason: OutReason): void {
    const s = this.seatOf(n);
    s.alive = false;
    s.out = { reason, day: this.day, night: this.night };
  }

  // ---------- Таймер ----------

  private pause(): void {
    const t = this.timer;
    if (!t || t.endsAt === null) fail('Нечего ставить на паузу');
    t.pausedRemainingMs = Math.max(0, t.endsAt - this.now);
    t.endsAt = null;
  }

  private resume(): void {
    const t = this.timer;
    if (!t || t.pausedRemainingMs === null) fail('Таймер не на паузе');
    t.endsAt = this.now + t.pausedRemainingMs;
    t.pausedRemainingMs = null;
  }

  private addTime(ms: number): void {
    const t = this.timer;
    if (!t) fail('Сейчас нет таймера');
    if (!(ms > 0 && ms <= 5 * 60_000)) fail('Можно добавить от 1 секунды до 5 минут');
    if (t.endsAt !== null) t.endsAt += ms;
    else t.pausedRemainingMs = (t.pausedRemainingMs ?? 0) + ms;
    t.durationMs += ms;
  }

  // ---------- Начало игры и нулевая ночь ----------

  private start(players: { playerId: string; nick: string }[], fixedSeats: boolean, roles?: Role[], instantDeal = false): void {
    if (this.phase !== 'lobby') fail('Игра уже началась');
    if (players.length !== 10) fail('Нужно ровно 10 игроков');
    if (new Set(players.map((p) => p.playerId)).size !== 10) fail('Игроки повторяются');
    const order = fixedSeats ? players : shuffle(players, this.rng);
    const deck = roles ?? shuffle(ROLE_DECK, this.rng);
    if (deck.length !== 10) fail('Нужно 10 ролей');
    this.deck = [...deck];
    this.deckTakenBy = Array(10).fill(null);
    this.seats = order.map((p, i) => ({
      seat: i + 1, playerId: p.playerId, nick: p.nick, role: 'civilian',
      dealtAt: null, alive: true, fouls: 0, muteNextSpeech: false, out: null,
    }));

    if (instantDeal) {
      for (let i = 0; i < 10; i++) this.takeCard(i + 1, i);
      return this.startZeroNight();
    }
    // 4.1.3: игроки по очереди вслепую тянут карту
    this.phase = 'deal';
    this.dealTurn = 1;
    this.write('Раздача карт. Игроки по очереди тянут карту из колоды');
    this.startTimer(this.settings.dealTurnMs);
  }

  // ---------- Раздача ----------

  private takeCard(seat: number, index: number): void {
    const s = this.seatOf(seat);
    s.role = this.deck[index];
    s.dealtAt = this.now;
    this.deckTakenBy[index] = seat;
  }

  private pickCard(seat: number, index: number): void {
    if (this.phase !== 'deal') fail('Раздача уже закончилась');
    if (this.dealTurn !== seat) fail('Сейчас тянет карту другой игрок');
    if (this.seatOf(seat).dealtAt !== null) fail('Вы уже взяли карту');
    if (!Number.isInteger(index) || index < 0 || index > 9 || this.deckTakenBy[index] !== null) fail('Эту карту уже взяли');
    this.takeCard(seat, index);
  }

  /** Ход раздачи закончился: кто не успел взять карту, получает случайную. */
  private nextDealTurn(): void {
    const seat = this.dealTurn!;
    if (this.seatOf(seat).dealtAt === null) {
      const free = this.deckTakenBy.flatMap((by, i) => (by === null ? [i] : []));
      this.takeCard(seat, free[Math.floor(this.rng() * free.length)]);
    }
    if (seat < 10) {
      this.dealTurn = seat + 1;
      return this.startTimer(this.settings.dealTurnMs);
    }
    this.dealTurn = null;
    this.startZeroNight();
  }

  private startZeroNight(): void {
    this.phase = 'zeroNight';
    const roleName = { civilian: 'мирный', sheriff: 'шериф', mafia: 'мафия', don: 'дон' };
    this.write(`Роли: ${this.seats.map((s) => `№${s.seat} ${roleName[s.role]}`).join(', ')}`, 'host');
    this.write('Наступает ночь. Мафия знакомится и договаривается');
    this.startTimer(this.settings.dogovorkaMs);
  }

  private requireDonAtZeroNight(seat: number): void {
    if (this.phase !== 'zeroNight') fail('Договорка уже закончилась');
    if (this.seatOf(seat).role !== 'don') fail('План задаёт только дон');
  }

  private setPlan(seat: number, plan: number[]): void {
    this.requireDonAtZeroNight(seat);
    if (!Array.isArray(plan) || plan.length > 4) fail('План: не больше 4 ночей');
    if (plan.some((n) => !Number.isInteger(n) || n < 1 || n > 10)) fail('В плане только номера 1-10');
    if (new Set(plan).size !== plan.length) fail('Номера в плане не повторяются');
    this.mafiaPlan.plan = [...plan];
    this.write(`План отстрела: ${plan.map((n, i) => `ночь ${i + 1} №${n}`).join(', ') || 'пусто'}`, 'black');
  }

  private setBeacon(seat: number, beacon: 0 | 1 | 2 | 3): void {
    this.requireDonAtZeroNight(seat);
    if (![0, 1, 2, 3].includes(beacon)) fail('Маяк: 0, +1, +2 или +3');
    this.mafiaPlan.beacon = beacon;
  }

  private setPhrase(seat: number, index: number): void {
    this.requireDonAtZeroNight(seat);
    if (!Number.isInteger(index) || index < 0 || index >= SHERIFF_PHRASES.length) fail('Нет такой фразы');
    this.mafiaPlan.sheriffPhrase = index;
  }

  // ---------- Переход к следующему шагу (таймер или ведущий) ----------

  private advance(): void {
    switch (this.phase) {
      case 'deal': return this.nextDealTurn();
      case 'zeroNight': {
        const p = this.mafiaPlan;
        this.write(`Договорка: план ${p.plan.join(', ') || 'не задан'}, маяк ${p.beacon ? '+' + p.beacon : 'нет'}, фраза «${SHERIFF_PHRASES[p.sheriffPhrase]}»`, 'host');
        return this.startDay(1);
      }
      case 'day': return this.nextSpeech();
      case 'tieSpeech': return this.nextTieSpeech();
      case 'voting': return this.closeVoteWindow();
      case 'liftVote': return this.resolveLift();
      case 'lastWord': return this.nextLastWord();
      case 'night': return this.advanceNight();
      default: fail('Сейчас нечего завершать');
    }
  }

  // ---------- День ----------

  private startDay(d: number): void {
    this.day = d;
    this.phase = 'day';
    this.nominations = [];
    this.voting = null;
    this.liftVote = null;
    // 4.3.2: первый день открывает №1, каждый следующий — следующий после открывавшего
    const from = d === 1 ? 1 : (this.dayOpener! % 10) + 1;
    const queue = this.circleFrom(from);
    this.dayOpener = queue[0];
    this.speechQueue = queue;
    this.write(`День ${d}. Первым говорит №${this.dayOpener}`);
    if (this.noVoteDays.has(d)) this.write('Сегодня голосования не будет: за столом было удаление');
    this.nextSpeech();
  }

  private nextSpeech(): void {
    const next = this.speechQueue.shift();
    if (next === undefined) return this.endDiscussion();
    const s = this.seatOf(next);
    this.speaker = next;
    this.speakerMuted = false;
    if (s.muteNextSpeech) {
      s.muteNextSpeech = false;
      if (this.aliveSeats().length <= 4) {
        // 7.6: при 3-4 игроках за столом — 30 секунд вместо молчания
        return this.startTimer(this.settings.reducedSpeechMs);
      }
      // 6.4: молчит, но может выставить кандидатуру
      this.speakerMuted = true;
      this.write(`№${next} пропускает речь (3 фола), но может выставить кандидатуру`);
      return this.startTimer(this.settings.mutedTurnMs);
    }
    this.startTimer(this.settings.speechMs);
  }

  private pass(seat: number): void {
    if (!['day', 'tieSpeech', 'lastWord'].includes(this.phase) || this.speaker !== seat) {
      fail('Сейчас не ваша минута');
    }
    this.advance();
  }

  private nominate(seat: number, target: number): void {
    if (this.phase !== 'day' || this.speaker !== seat) fail('Выставлять можно только в свою минуту');
    this.requireAlive(target);
    if (this.nominations.some((n) => n.by === seat)) fail('Вы уже выставили кандидатуру сегодня'); // 4.4.3
    if (this.nominations.some((n) => n.target === target)) fail(`№${target} уже выставлен`);
    this.nominations.push({ target, by: seat });
    this.write(`№${seat} выставляет №${target}`);
  }

  private endDiscussion(): void {
    this.speaker = null;
    this.speakerMuted = false;
    if (this.noVoteDays.has(this.day)) {
      this.write('Голосование не проводится');
      return this.goNight();
    }
    const candidates = this.nominations.map((n) => n.target).filter((n) => this.seatOf(n).alive);
    if (candidates.length === 0) {
      this.write('Никто не выставлен, голосования нет');
      return this.goNight();
    }
    if (this.day === 1 && candidates.length === 1) {
      this.write(`В первый день выставлен только №${candidates[0]}, голосование не проводится`); // 4.4.10
      return this.goNight();
    }
    this.startVoting(candidates, null);
  }

  // ---------- Голосование ----------

  private startVoting(candidates: number[], previousTie: number[] | null): void {
    this.phase = 'voting';
    this.speaker = null;
    this.voting = { candidates, index: 0, votes: {}, previousTie };
    this.write(`Голосование. Кандидаты: ${candidates.map((n) => '№' + n).join(', ')}`);
    this.startTimer(this.settings.voteWindowMs);
  }

  private vote(seat: number, target: number): void {
    const v = this.voting;
    if (this.phase !== 'voting' || !v) fail('Сейчас нет голосования');
    this.requireAlive(seat);
    if (seat in v.votes) fail('Вы уже проголосовали'); // 4.4.7
    if (v.candidates[v.index] !== target) fail('Сейчас голосуем за другого кандидата');
    v.votes[seat] = target;
  }

  private closeVoteWindow(): void {
    const v = this.voting!;
    v.index++;
    if (v.index < v.candidates.length) return this.startTimer(this.settings.voteWindowMs);

    // 4.4.8: кто не проголосовал, голосует против последнего кандидата
    const last = v.candidates[v.candidates.length - 1];
    for (const n of this.aliveSeats()) if (!(n in v.votes)) v.votes[n] = last;

    const counts = new Map<number, number>(v.candidates.map((c) => [c, 0]));
    for (const target of Object.values(v.votes)) counts.set(target, (counts.get(target) ?? 0) + 1);
    this.write(`Итоги: ${v.candidates.map((c) => `№${c} — ${counts.get(c)}`).join(', ')}`);
    for (const c of v.candidates) {
      const voters = Object.entries(v.votes).filter(([, t]) => t === c).map(([s]) => s);
      if (voters.length) this.write(`Против №${c}: ${voters.join(', ')}`);
    }

    const max = Math.max(...counts.values());
    const leaders = v.candidates.filter((c) => counts.get(c) === max);
    if (leaders.length === 1) return this.eliminateByVote(leaders);

    const sameTie = v.previousTie !== null
      && v.previousTie.length === leaders.length
      && leaders.every((c) => v.previousTie!.includes(c));
    if (!sameTie) return this.startTie(leaders); // 4.4.12, 4.4.12.2
    if (leaders.length === this.aliveSeats().length) {
      this.write('Голосование за подъём всего стола не проводится, все остаются'); // 7.8
      return this.goNight();
    }
    this.startLift(leaders); // 4.4.12.3
  }

  private startTie(leaders: number[]): void {
    this.phase = 'tieSpeech';
    this.voting = null;
    this.tieCandidates = leaders;
    this.tieQueue = [...leaders];
    this.write(`Голоса поделились: ${leaders.map((n) => '№' + n).join(', ')}. По 30 секунд на оправдание`);
    this.nextTieSpeech();
  }

  private nextTieSpeech(): void {
    const next = this.tieQueue.shift();
    if (next === undefined) {
      this.speaker = null;
      return this.startVoting(this.tieCandidates, this.tieCandidates);
    }
    this.speaker = next;
    this.speakerMuted = false; // 7.5: при 3 фолах в переголосовании слово есть
    this.startTimer(this.settings.reducedSpeechMs);
  }

  private startLift(candidates: number[]): void {
    this.phase = 'liftVote';
    this.voting = null;
    this.liftVote = { candidates, yes: [] };
    this.write(`Кто за то, чтобы ${candidates.map((n) => '№' + n).join(', ')} покинули стол?`);
    this.startTimer(this.settings.voteWindowMs);
  }

  private liftYes(seat: number): void {
    const l = this.liftVote;
    if (this.phase !== 'liftVote' || !l) fail('Сейчас нет такого голосования');
    this.requireAlive(seat);
    if (l.yes.includes(seat)) fail('Вы уже проголосовали');
    l.yes.push(seat);
  }

  private resolveLift(): void {
    const l = this.liftVote!;
    const alive = this.aliveSeats().length;
    this.write(`За подъём: ${l.yes.length} из ${alive}`);
    if (l.yes.length > alive / 2) return this.eliminateByVote(l.candidates);
    this.write('Большинства нет, все остаются');
    this.liftVote = null;
    this.goNight();
  }

  private eliminateByVote(seats: number[]): void {
    for (const n of seats) {
      this.markOut(n, 'voted');
      this.write(`№${n} покидает стол по итогам голосования`);
    }
    if (this.day === 1 && seats.length >= 2) this.bestMoveBlocked = true;
    this.voting = null;
    this.liftVote = null;
    this.checkWin();
    this.startLastWords(seats, 'night');
  }

  // ---------- Последняя минута ----------

  private startLastWords(seats: number[], then: 'night' | 'day'): void {
    this.phase = 'lastWord';
    this.lastWordQueue = [...seats];
    this.afterLastWord = then;
    this.nextLastWord();
  }

  private nextLastWord(): void {
    const next = this.lastWordQueue.shift();
    if (next === undefined) {
      this.speaker = null;
      if (this.winner) return this.end();
      return this.afterLastWord === 'night' ? this.goNight() : this.startDay(this.day + 1);
    }
    this.speaker = next;
    this.speakerMuted = false;
    this.write(`Последняя минута №${next}`);
    this.startTimer(this.settings.lastWordMs);
  }

  // ---------- Ночь ----------

  private goNight(): void {
    this.night++;
    this.phase = 'night';
    this.speaker = null;
    this.voting = null;
    this.liftVote = null;
    this.shots = {};
    this.nightKill = null;
    this.donCheckedTonight = false;
    this.sheriffCheckedTonight = false;
    this.write(`Ночь ${this.night}`);
    this.setNightStep('shoot');
  }

  private setNightStep(step: NightStep): void {
    this.nightStep = step;
    const s = this.settings;
    const ms = { shoot: s.shootMs, don: s.checkMs, sheriff: s.checkMs, bestMove: s.bestMoveMs }[step];
    const say = {
      shoot: 'Мафия выходит на охоту',
      don: 'Просыпается дон и ищет шерифа',
      sheriff: 'Просыпается шериф',
      bestMove: `Игрок №${this.nightKill}, вас убили. 20 секунд на лучший ход`,
    }[step];
    this.write(say);
    this.startTimer(ms);
  }

  private shoot(seat: number, target: number): void {
    if (this.phase !== 'night' || this.nightStep !== 'shoot') fail('Сейчас не время стрелять');
    this.requireAlive(seat);
    if (!this.isBlack(seat)) fail('Стреляет только мафия');
    if (seat in this.shots) fail('Выстрел уже сделан');
    this.requireAlive(target);
    this.shots[seat] = target;
    this.write(`№${seat} стреляет в №${target}`, 'host');
  }

  private check(seat: number, target: number): void {
    if (this.phase !== 'night') fail('Проверки только ночью');
    const role = this.seatOf(seat).role;
    this.requireAlive(seat); // убитый этой ночью ещё за столом до утра (4.5.4)
    this.seatOf(target);
    if (target === seat) fail('Себя проверять нельзя');
    if (this.nightStep === 'don' && role === 'don') {
      if (this.donCheckedTonight) fail('Проверка уже сделана'); // 4.5.8
      const result = this.seatOf(target).role === 'sheriff';
      this.donCheckedTonight = true;
      this.donChecks.push({ night: this.night, target, result });
      this.write(`Проверка дона: №${target} ${result ? 'шериф' : 'не шериф'}`, { seat });
      this.write(`Дон проверил №${target}: ${result ? 'шериф' : 'не шериф'}`, 'host');
      return;
    }
    if (this.nightStep === 'sheriff' && role === 'sheriff') {
      if (this.sheriffCheckedTonight) fail('Проверка уже сделана');
      const result = this.isBlack(target);
      this.sheriffCheckedTonight = true;
      this.sheriffChecks.push({ night: this.night, target, result });
      this.write(`Проверка шерифа: №${target} ${result ? 'чёрный' : 'красный'}`, { seat });
      this.write(`Шериф проверил №${target}: ${result ? 'чёрный' : 'красный'}`, 'host');
      return;
    }
    fail('Сейчас не ваша проверка');
  }

  private makeBestMove(seat: number, seats: number[]): void {
    if (this.phase !== 'night' || this.nightStep !== 'bestMove' || seat !== this.nightKill) {
      fail('Лучший ход сейчас не ваш');
    }
    if (this.bestMove) fail('Лучший ход уже сделан'); // 8.3.3
    if (!Array.isArray(seats) || seats.length < 1 || seats.length > 3) fail('Назовите до трёх номеров');
    if (seats.some((n) => !Number.isInteger(n) || n < 1 || n > 10)) fail('Только номера 1-10');
    if (new Set(seats).size !== seats.length) fail('Номера не повторяются');
    this.bestMove = { by: seat, seats: [...seats] };
    this.advance();
  }

  private advanceNight(): void {
    switch (this.nightStep) {
      case 'shoot': {
        // 4.5.4-4.5.5: убийство, только если все живые чёрные выстрелили в одного
        const blacks = this.aliveSeats().filter((n) => this.isBlack(n));
        const targets = blacks.map((b) => this.shots[b]);
        const hit = blacks.length > 0 && targets.every((t) => t !== undefined && t === targets[0]);
        this.nightKill = hit ? targets[0]! : null;
        this.write(hit ? `Мафия убивает №${this.nightKill}` : 'Промах мафии', 'host');
        // Шаги дона и шерифа идут всегда, даже если их уже нет: иначе стол поймёт, кто выбыл
        return this.setNightStep('don');
      }
      case 'don': return this.setNightStep('sheriff');
      case 'sheriff':
        if (this.night === 1 && this.nightKill !== null && !this.bestMoveBlocked) {
          return this.setNightStep('bestMove'); // 4.5.9
        }
        return this.morning();
      case 'bestMove': return this.morning();
      default: fail('Ночь не идёт');
    }
  }

  private morning(): void {
    this.nightStep = null;
    const killed = this.nightKill;
    if (killed !== null && this.seatOf(killed).alive) {
      this.markOut(killed, 'killed');
      this.write(`Утро. Ночью убит №${killed}`);
      if (this.bestMove && this.bestMove.by === killed) {
        this.write(`Лучший ход №${killed}: ${this.bestMove.seats.join(', ')}`);
      }
    } else if (killed === null) {
      this.write('Утро. Ночью никто не убит');
    } else {
      this.write('Утро'); // мишень удалили ночью за нарушение, убивать уже некого
    }

    const alive = this.aliveSeats().length;
    this.stagnantNights = alive === this.aliveAtLastMorning ? this.stagnantNights + 1 : 0;
    this.aliveAtLastMorning = alive;

    this.checkWin();
    if (!this.winner && this.stagnantNights >= 3) {
      this.winner = 'draw';
      this.endReason = 'Три ночи подряд никто не покинул стол'; // 7.7
    }
    if (killed !== null && this.seatOf(killed).out?.reason === 'killed') {
      return this.startLastWords([killed], 'day'); // 7.9: последнее слово есть и при решающем убийстве
    }
    if (this.winner) return this.end();
    this.startDay(this.day + 1);
  }

  // ---------- Фолы, удаления, ППК ----------

  private requireDealt(): void {
    this.requireRunning();
    if (this.phase === 'deal') fail('Подождите конца раздачи');
  }

  private foul(n: number, delta: 1 | -1): void {
    this.requireDealt();
    const s = this.seatOf(n);
    if (!s.alive && !(this.phase === 'lastWord' && this.speaker === n)) fail(`Игрок №${n} уже не в игре`);
    if (delta !== 1 && delta !== -1) fail('Фол: +1 или −1');
    if (delta === -1 && s.fouls === 0) fail('Фолов нет');
    s.fouls += delta;
    if (delta === 1) this.write(`Фол №${n} (${s.fouls}-й)`);
    else this.write(`С №${n} снят фол, теперь ${s.fouls}`);
    s.muteNextSpeech = s.fouls === 3 ? (delta === 1 ? true : s.muteNextSpeech) : false;
    if (s.fouls >= 4) this.remove(n, '4-й фол'); // 6.5
  }

  private remove(n: number, why: string): void {
    this.requireDealt();
    const s = this.seatOf(n);
    const leavingNow = this.phase === 'lastWord' && (this.speaker === n || this.lastWordQueue.includes(n));
    if (!s.alive && !leavingNow) fail(`Игрок №${n} уже не в игре`);

    const wasAlive = s.alive;
    if (wasAlive) this.markOut(n, 'removed');
    this.write(`№${n} удалён: ${why}`);

    this.speechQueue = this.speechQueue.filter((x) => x !== n);
    this.tieQueue = this.tieQueue.filter((x) => x !== n);
    this.lastWordQueue = this.lastWordQueue.filter((x) => x !== n);

    // 7.1-7.2: удаление отменяет ближайшее голосование,
    // кроме уходящего по голосованию и убитого этой ночью
    const killedTonight = this.phase === 'night' && this.nightKill === n;
    let abortVoting = false;
    if (wasAlive && !killedTonight) {
      const beforeResult = ['day', 'tieSpeech', 'voting', 'liftVote'].includes(this.phase);
      this.noVoteDays.add(beforeResult ? this.day : this.day + 1);
      abortVoting = ['tieSpeech', 'voting', 'liftVote'].includes(this.phase);
    }

    this.checkWin();
    if (this.winner && this.phase !== 'lastWord') return this.end();

    if (abortVoting) {
      this.write('Голосование отменено');
      return this.goNight();
    }
    if (this.speaker === n && ['day', 'tieSpeech', 'lastWord'].includes(this.phase)) this.advance();
  }

  private ppk(n: number): void {
    this.requireDealt();
    const team: Team = teamOf(this.seatOf(n).role);
    this.winner = team === 'red' ? 'black' : 'red';
    this.endReason = `ППК: грубое нарушение №${n}`;
    this.write(`№${n}: присуждение поражения команде`);
    this.end();
  }

  // ---------- Победа ----------

  private checkWin(): void {
    if (this.winner) return;
    const alive = this.aliveSeats();
    const blacks = alive.filter((n) => this.isBlack(n)).length;
    const reds = alive.length - blacks;
    if (blacks === 0) {
      this.winner = 'red';
      this.endReason = 'Вся мафия выведена из игры';
    } else if (blacks >= reds) {
      this.winner = 'black';
      this.endReason = 'Чёрных за столом не меньше, чем красных';
    }
  }

  private end(): void {
    this.phase = 'ended';
    this.timer = null;
    this.speaker = null;
    this.nightStep = null;
    const names = { red: 'красных', black: 'чёрных', draw: '' };
    this.write(this.winner === 'draw' ? `Ничья. ${this.endReason}` : `Победа ${names[this.winner!]}. ${this.endReason}`);
  }

  // ---------- Для голоса и интерфейса ----------

  /** Чей микрофон сейчас открыт (ведущий слышен всегда). */
  micOpen(): number[] {
    if (['day', 'tieSpeech', 'lastWord'].includes(this.phase) && this.speaker !== null && !this.speakerMuted) {
      return [this.speaker];
    }
    return [];
  }
}

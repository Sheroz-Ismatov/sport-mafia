// Что видит каждый участник. Сервер отправляет в браузер только результат viewFor(),
// поэтому чужую роль нельзя подсмотреть даже через инструменты разработчика.

import { SHERIFF_PHRASES, teamOf } from './types.ts';
import type {
  CheckResult, LogAudience, NightStep, Nomination, OutReason, Phase, Role, Team, Timer, Winner,
} from './types.ts';
import type { Game } from './game.ts';

export type Viewer = { kind: 'host' } | { kind: 'player'; seat: number } | { kind: 'spectator' };

export interface SeatView {
  seat: number;
  nick: string;
  alive: boolean;
  fouls: number;
  out: { reason: OutReason; day: number; night: number } | null;
  role: Role | null; // null — роль скрыта от этого зрителя
  dealtAt: number | null; // когда взял карту на раздаче (для анимации)
}

export interface GameView {
  as: 'host' | 'player' | 'eliminated' | 'spectator';
  phase: Phase;
  day: number;
  night: number;
  nightStep: NightStep | null;
  timer: Timer | null;
  deal: { turn: number | null; takenBy: (number | null)[] } | null; // раздача: чей ход, кто какую карту взял
  speaker: number | null;
  speakerMuted: boolean;
  speechQueue: number[];
  nominations: Nomination[];
  noVoteToday: boolean;
  voting: { candidates: number[]; index: number; votes: Record<number, number> } | null;
  tie: { candidates: number[]; queue: number[] } | null;
  lift: { candidates: number[]; yes: number[] } | null;
  lastWordQueue: number[];
  micOpen: number[];
  seats: SeatView[];
  me: { seat: number; role: Role; team: Team; alive: boolean } | null; // null у зрителя и до того, как игрок взял карту
  mySeat: number | null;
  mafia: {
    members: { seat: number; role: Role }[];
    plan: number[];
    beacon: number;
    sheriffPhrase: string;
    phrases: readonly string[];
    planTargetTonight: number | null;
  } | null;
  myShot: number | null;
  myChecks: CheckResult[];
  bestMoveBy: number | null;                         // кого убили в первую ночь, пока идёт лучший ход
  bestMoveSize: number;                              // сколько номеров назвать: по числу чёрных
  bestMove: { by: number; seats: number[] } | null;  // открывается всем утром
  winner: Winner | null;
  endReason: string;
  log: { at: number; day: number; night: number; text: string }[];
  host: {
    shots: Record<number, number>;
    nightKill: number | null;
    donChecks: CheckResult[];
    sheriffChecks: CheckResult[];
    plan: number[];
    beacon: number;
    sheriffPhrase: string;
    noVoteDays: number[];
  } | null;
}

function canSee(audience: LogAudience, viewer: Viewer, game: Game, ended: boolean): boolean {
  if (ended || viewer.kind === 'host' || audience === 'public') return true;
  if (viewer.kind !== 'player') return false;
  if (audience === 'black') return game.isBlack(viewer.seat);
  if (typeof audience === 'object') return audience.seat === viewer.seat;
  return false;
}

export function viewFor(game: Game, viewer: Viewer): GameView {
  const ended = game.phase === 'ended';
  const isHost = viewer.kind === 'host';
  const mySeat = viewer.kind === 'player' && game.seats.length ? game.seatOf(viewer.seat) : null;
  const dealing = game.phase === 'deal';
  // Чёрные узнают друг друга только на договорке, после раздачи
  const iAmBlack = !dealing && mySeat !== null && teamOf(mySeat.role) === 'black';

  let as: GameView['as'] = 'spectator';
  if (isHost) as = 'host';
  else if (mySeat) as = mySeat.alive ? 'player' : 'eliminated';

  const roleVisible = (seat: number, role: Role): boolean => {
    if (game.seatOf(seat).dealtAt === null) return false; // карту ещё не взяли
    if (ended || isHost) return true;
    if (!mySeat) return false;
    if (seat === mySeat.seat) return true;
    return iAmBlack && teamOf(role) === 'black';
  };

  const seats: SeatView[] = game.seats.map((s) => ({
    seat: s.seat,
    nick: s.nick,
    alive: s.alive,
    fouls: s.fouls,
    out: s.out,
    role: roleVisible(s.seat, s.role) ? s.role : null,
    dealtAt: s.dealtAt,
  }));

  const plan = game.mafiaPlan;
  const tonight = game.phase === 'night' ? game.night : game.night + 1;
  const mafia = iAmBlack || (isHost && !dealing) ? {
    members: game.seats.filter((s) => teamOf(s.role) === 'black').map((s) => ({ seat: s.seat, role: s.role })),
    plan: [...plan.plan],
    beacon: plan.beacon,
    sheriffPhrase: SHERIFF_PHRASES[plan.sheriffPhrase],
    phrases: SHERIFF_PHRASES,
    planTargetTonight: plan.plan[tonight - 1] ?? null,
  } : null;

  let myChecks: CheckResult[] = [];
  if (mySeat?.role === 'don') myChecks = game.donChecks;
  if (mySeat?.role === 'sheriff') myChecks = game.sheriffChecks;

  // Лучший ход становится общим утром, когда убитый покинул стол
  const bm = game.bestMove;
  const bestMovePublic = bm !== null && !game.seatOf(bm.by).alive;
  const bestMove = bm && (bestMovePublic || isHost || mySeat?.seat === bm.by) ? bm : null;

  const v = game.voting;
  return {
    as,
    phase: game.phase,
    day: game.day,
    night: game.night,
    nightStep: game.nightStep,
    timer: game.timer ? { ...game.timer } : null,
    deal: dealing ? { turn: game.dealTurn, takenBy: [...game.deckTakenBy] } : null,
    speaker: game.speaker,
    speakerMuted: game.speakerMuted,
    speechQueue: game.phase === 'day' ? [...game.speechQueue] : [],
    nominations: [...game.nominations],
    noVoteToday: game.noVoteDays.has(game.day),
    voting: v ? { candidates: [...v.candidates], index: v.index, votes: { ...v.votes } } : null,
    tie: game.phase === 'tieSpeech' ? { candidates: [...game.tieCandidates], queue: [...game.tieQueue] } : null,
    lift: game.liftVote ? { candidates: [...game.liftVote.candidates], yes: [...game.liftVote.yes] } : null,
    lastWordQueue: game.phase === 'lastWord' ? [...game.lastWordQueue] : [],
    micOpen: game.micOpen(),
    seats,
    me: mySeat && mySeat.dealtAt !== null
      ? { seat: mySeat.seat, role: mySeat.role, team: teamOf(mySeat.role), alive: mySeat.alive }
      : null,
    mySeat: mySeat?.seat ?? null,
    mafia,
    myShot: iAmBlack && game.phase === 'night' ? game.shots[mySeat!.seat] ?? null : null,
    myChecks: [...myChecks],
    bestMoveBy: game.nightStep === 'bestMove' ? game.nightKill : null,
    bestMoveSize: dealing || !game.seats.length ? 3 : game.bestMoveSize(),
    bestMove,
    winner: game.winner && ended ? game.winner : null,
    endReason: ended ? game.endReason : '',
    log: game.log
      .filter((e) => canSee(e.audience, viewer, game, ended))
      .map(({ at, day, night, text }) => ({ at, day, night, text })),
    host: isHost ? {
      shots: { ...game.shots },
      nightKill: game.nightKill,
      donChecks: [...game.donChecks],
      sheriffChecks: [...game.sheriffChecks],
      plan: [...plan.plan],
      beacon: plan.beacon,
      sheriffPhrase: SHERIFF_PHRASES[plan.sheriffPhrase],
      noVoteDays: [...game.noVoteDays],
    } : null,
  };
}

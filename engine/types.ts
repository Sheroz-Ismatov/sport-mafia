// Базовые типы спортивной мафии (правила ФСМ, редакция 23.01.2023).

export type Role = 'civilian' | 'sheriff' | 'mafia' | 'don';
export type Team = 'red' | 'black';

export function teamOf(role: Role): Team {
  return role === 'mafia' || role === 'don' ? 'black' : 'red';
}

/** Длительности всех фаз в миллисекундах. Ведущий может менять их в настройках комнаты. */
export interface Settings {
  speechMs: number;        // минута речи
  reducedSpeechMs: number; // 30 с: оправдание при ничьей и речь при 3 фолах, когда за столом 3-4 игрока
  mutedTurnMs: number;     // ход игрока с 3 фолами: молчит, но может выставить
  lastWordMs: number;      // последняя минута
  dogovorkaMs: number;     // договорка мафии
  voteWindowMs: number;    // окно голосования за одного кандидата
  shootMs: number;         // выстрел мафии
  checkMs: number;         // проверка дона или шерифа
  bestMoveMs: number;      // лучший ход
  dealTurnMs: number;      // ход одного игрока на раздаче: взять карту и посмотреть роль
}

export const DEFAULT_SETTINGS: Settings = {
  speechMs: 60_000,
  reducedSpeechMs: 30_000,
  mutedTurnMs: 10_000,
  lastWordMs: 60_000,
  dogovorkaMs: 60_000,
  voteWindowMs: 5_000,
  shootMs: 15_000,
  checkMs: 10_000,
  bestMoveMs: 20_000,
  dealTurnMs: 6_000,       // 10 игроков × 6 с = минута на раздачу
};

/** За столом от 6 до 10 игроков. */
export const MIN_PLAYERS = 6;
export const MAX_PLAYERS = 10;

/**
 * Состав ролей по числу игроков. Полный стол (10): 6 мирных, шериф, 2 мафии, дон — как в регламенте.
 * Неполный стол (6-9) — упрощённый вариант не по регламенту: чёрных двое (дон и мафия), шериф остаётся.
 */
export function roleCounts(players: number): Record<Role, number> {
  const blacks = players >= 10 ? 3 : 2;
  return { civilian: players - blacks - 1, sheriff: 1, mafia: blacks - 1, don: 1 };
}

export function roleDeck(players: number): Role[] {
  const c = roleCounts(players);
  return (Object.keys(c) as Role[]).flatMap((r) => Array<Role>(c[r]).fill(r));
}

export type OutReason = 'voted' | 'killed' | 'removed';

export interface Seat {
  seat: number;          // 1..10
  playerId: string;
  nick: string;
  role: Role;            // до того как игрок взял карту — заглушка, смотрите dealtAt
  dealtAt: number | null; // когда игрок взял карту (null — ещё не взял)
  alive: boolean;
  fouls: number;         // 0..4
  muteNextSpeech: boolean; // 3-й фол: молчит ближайшую минуту
  out: { reason: OutReason; day: number; night: number } | null;
}

export type Phase =
  | 'lobby'
  | 'deal'        // раздача: по очереди тянут карту из колоды
  | 'zeroNight'   // договорка
  | 'day'         // речи по кругу
  | 'tieSpeech'   // оправдания 30 с при ничьей
  | 'voting'      // голосование по кандидатам
  | 'liftVote'    // «кто за то, чтобы все покинули стол?»
  | 'lastWord'    // последняя минута ушедших
  | 'night'
  | 'ended';

export type NightStep = 'shoot' | 'don' | 'sheriff' | 'bestMove';

export interface Timer {
  durationMs: number;
  endsAt: number | null;        // null, пока таймер на паузе
  pausedRemainingMs: number | null;
}

export interface Nomination { target: number; by: number }

export interface Voting {
  candidates: number[];          // в порядке выставления
  index: number;                 // за кого голосуем сейчас
  votes: Record<number, number>; // голосующий -> кандидат
  previousTie: number[] | null;  // кандидаты прошлого попила
}

export interface LiftVote { candidates: number[]; yes: number[] }

export interface MafiaPlan {
  plan: number[];        // номер мишени по ночам: plan[0] — первая ночь
  beacon: 0 | 1 | 2 | 3; // маяк: первый номер в речи дона + beacon (0 — без маяка)
  sheriffPhrase: number; // индекс в SHERIFF_PHRASES
}

export const SHERIFF_PHRASES = ['Город сегодня спокоен', 'Интересный стол', 'Начну с хорошего'] as const;

export interface CheckResult { night: number; target: number; result: boolean }

/** Кто видит запись протокола. */
export type LogAudience = 'public' | 'host' | 'black' | { seat: number };

export interface LogEntry {
  at: number;
  day: number;
  night: number;
  text: string;
  audience: LogAudience;
}

export type Winner = 'red' | 'black' | 'draw';

/** Кто совершает действие. system — таймер сервера. */
export type Actor = { kind: 'host' } | { kind: 'seat'; seat: number } | { kind: 'system' };

export type Action =
  // ведущий
  // players — по порядку мест, если задано fixedSeats, иначе места разыгрываются.
  // roles — только для тестов: колода в заданном порядке (карта i достаётся месту i+1 при instantDeal).
  // instantDeal — только для тестов: пропустить раздачу.
  | { type: 'start'; players: { playerId: string; nick: string }[]; fixedSeats?: boolean; roles?: Role[]; instantDeal?: boolean }
  | { type: 'next' }                    // досрочно закончить текущий шаг
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'addTime'; ms: number }
  | { type: 'foul'; seat: number; delta: 1 | -1 }
  | { type: 'remove'; seat: number }    // дисквалифицирующий фол
  | { type: 'ppk'; seat: number }       // победа противоположной команды
  // таймер
  | { type: 'timeout' }
  // игроки
  | { type: 'pickCard'; index: number } // взять карту из колоды на раздаче
  | { type: 'pass' }
  | { type: 'nominate'; target: number }
  | { type: 'vote'; target: number }
  | { type: 'liftYes' }
  | { type: 'setPlan'; plan: number[] }
  | { type: 'setBeacon'; beacon: 0 | 1 | 2 | 3 }
  | { type: 'setPhrase'; index: number }
  | { type: 'shoot'; target: number }
  | { type: 'check'; target: number }
  | { type: 'bestMove'; seats: number[] };

export type ActionResult = { ok: true } | { ok: false; error: string };

import type { GameView, Role, SeatView } from '../../engine/index.ts';

/** Экранирование текста для вставки в HTML: ники вводят люди. */
export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const ROLE_NAME: Record<Role, string> = {
  civilian: 'Мирный житель',
  sheriff: 'Шериф',
  mafia: 'Мафия',
  don: 'Дон',
};

export const ROLE_SHORT: Record<Role, string> = {
  civilian: 'мирный',
  sheriff: 'шериф',
  mafia: 'мафия',
  don: 'дон',
};

export function isBlackRole(role: Role | null): boolean {
  return role === 'mafia' || role === 'don';
}

export function clock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Сколько осталось на таймере с учётом разницы часов сервера и телефона. */
export function remainingMs(game: GameView, offset: number): number | null {
  const t = game.timer;
  if (!t) return null;
  if (t.endsAt === null) return t.pausedRemainingMs ?? 0;
  return t.endsAt - (Date.now() + offset);
}

export function seatLabel(game: GameView, n: number | null): string {
  if (n === null) return '';
  const s = game.seats[n - 1];
  return s ? `№${n} ${s.nick}` : `№${n}`;
}

export function outText(s: SeatView): string {
  if (!s.out) return '';
  if (s.out.reason === 'voted') return `ушёл днём ${s.out.day}`;
  if (s.out.reason === 'killed') return `убит ночью ${s.out.night}`;
  return 'удалён';
}

export function phaseTitle(game: GameView): string {
  switch (game.phase) {
    case 'deal': return 'Раздача карт';
    case 'zeroNight': return 'Договорка';
    case 'day': return `День ${game.day}`;
    case 'tieSpeech': return 'Попил';
    case 'voting': return 'Голосование';
    case 'liftVote': return 'Подъём';
    case 'lastWord': return 'Последняя минута';
    case 'night': return `Ночь ${game.night}`;
    case 'ended': return 'Игра окончена';
    default: return '';
  }
}

export const NIGHT_STEP: Record<string, string> = {
  shoot: 'Мафия выходит на охоту',
  don: 'Дон ищет шерифа',
  sheriff: 'Шериф проверяет',
  bestMove: 'Лучший ход',
};

export function isNightLike(game: GameView | null): boolean {
  return !!game && (game.phase === 'night' || game.phase === 'zeroNight');
}

export function winnerText(game: GameView): string {
  if (game.winner === 'red') return 'Победа красных';
  if (game.winner === 'black') return 'Победа чёрных';
  if (game.winner === 'draw') return 'Ничья';
  return 'Игра окончена';
}

/** Центр места на круглом столе в процентах. Место №1 сверху, дальше по часовой. total — мест за столом. */
export function seatPosition(n: number, total = 10): { left: number; top: number } {
  const angle = (-90 + (n - 1) * (360 / total)) * Math.PI / 180;
  return { left: 50 + 39 * Math.cos(angle), top: 50 + 38.5 * Math.sin(angle) };
}

// Простые боты, чтобы проверять партию, когда за столом меньше 10 человек.
// Бот знает только то, что положено его роли, и ходит случайно.

import { Game, teamOf } from '../engine/index.ts';
import type { Action } from '../engine/index.ts';

function pick<T>(items: T[], rng: () => number): T | undefined {
  return items.length ? items[Math.floor(rng() * items.length)] : undefined;
}

/** Что бот на месте seat хочет сделать прямо сейчас. null — ничего. */
export function botAction(game: Game, seat: number, rng: () => number = Math.random): Action | null {
  const me = game.seatOf(seat);
  const alive = game.aliveSeats();
  const others = alive.filter((n) => n !== seat);
  const black = teamOf(me.role) === 'black';
  if (game.hold) return null; // ждём ведущего

  switch (game.phase) {
    case 'deal': {
      if (game.dealTurn !== seat || me.dealtAt !== null) return null;
      const free = game.deckTakenBy.flatMap((by, i) => (by === null ? [i] : []));
      const index = pick(free, rng);
      return index === undefined ? null : { type: 'pickCard', index };
    }
    case 'zeroNight': {
      if (me.role !== 'don' || game.mafiaPlan.plan.length) return null;
      const reds = others.filter((n) => !game.isBlack(n));
      const plan: number[] = [];
      while (plan.length < 3) {
        const n = pick(reds.filter((r) => !plan.includes(r)), rng);
        if (n === undefined) break;
        plan.push(n);
      }
      return { type: 'setPlan', plan };
    }
    case 'day': {
      if (game.speaker !== seat) return null;
      const already = game.nominations.some((n) => n.by === seat);
      if (!already && rng() < 0.5) {
        const free = others.filter((n) => !game.nominations.some((x) => x.target === n));
        const target = pick(free, rng);
        if (target !== undefined) return { type: 'nominate', target };
      }
      return { type: 'pass' };
    }
    case 'tieSpeech':
    case 'lastWord':
      return game.speaker === seat ? { type: 'pass' } : null;
    case 'voting': {
      const v = game.voting!;
      if (!me.alive || seat in v.votes) return null;
      return rng() < 0.4 ? { type: 'vote', target: v.candidates[v.index] } : null;
    }
    case 'liftVote':
      if (!me.alive || game.liftVote!.yes.includes(seat)) return null;
      return rng() < 0.5 ? { type: 'liftYes' } : null;
    case 'night': {
      if (!me.alive) return null;
      if (game.nightStep === 'shoot' && black && !(seat in game.shots)) {
        const planned = game.mafiaPlan.plan[game.night - 1];
        const target = planned && game.seatOf(planned).alive
          ? planned
          : Math.min(...alive.filter((n) => !game.isBlack(n))); // все чёрные выберут одного
        return { type: 'shoot', target };
      }
      if (game.nightStep === 'don' && me.role === 'don' && !game.donCheckedTonight) {
        const target = pick(others.filter((n) => !game.isBlack(n)), rng);
        return target === undefined ? null : { type: 'check', target };
      }
      if (game.nightStep === 'sheriff' && me.role === 'sheriff' && !game.sheriffCheckedTonight) {
        const target = pick(others, rng);
        return target === undefined ? null : { type: 'check', target };
      }
      if (game.nightStep === 'bestMove' && game.nightKill === seat && !game.bestMove) {
        const seats: number[] = [];
        while (seats.length < game.bestMoveSize()) {
          const n = pick(others.filter((x) => !seats.includes(x)), rng);
          if (n === undefined) break;
          seats.push(n);
        }
        return { type: 'bestMove', seats };
      }
      return null;
    }
    default:
      return null;
  }
}

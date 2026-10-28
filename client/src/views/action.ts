// Панель действия внизу экрана: появляется, только когда от игрока ждут хода.
// Заголовок шага, таймер и одна главная кнопка, чтобы не листать до неё под столом.

import type { GameView } from '../../../engine/index.ts';
import type { Store } from '../store.ts';
import { clock, remainingMs } from '../util.ts';
import { cardBack } from './cards.ts';
import type { PickMode } from './play.ts';

function bar(game: GameView, store: Store, title: string, body: string, tone = ''): string {
  const left = remainingMs(game, store.offset);
  const timer = left === null ? '' : `<span class="ab-clock" data-clock>${clock(left)}</span>`;
  return `<div class="action-bar ${tone}" role="region" aria-label="Твой ход">
    <div class="ab-head"><b>${title}</b>${timer}</div>
    ${body}
  </div>`;
}

/** Кнопка подтверждения выбора за столом: пока номер не выбран, подсказывает, что делать. */
function confirmButton(store: Store, verb: string, cls: string, empty: string): string {
  const sel = store.selected;
  return sel.length
    ? `<button class="btn ${cls}" data-act="confirm">${verb} ${sel.map((n) => '№' + n).join(', ')}</button>`
    : `<button class="btn ghost" disabled>${empty}</button>`;
}

export function actionBar(store: Store, game: GameView, mode: PickMode | null): string {
  const me = game.me;
  const mySeat = game.mySeat;
  if (!mySeat || game.phase === 'ended') return '';

  // Раздача: моя очередь тянуть карту, колода одним рядом прямо в панели
  if (game.phase === 'deal' && game.deal && game.deal.turn === mySeat && !me) {
    const cards = game.deal.takenBy
      .map((by, i) => (by === null ? `<button class="ab-card" data-act="card" data-n="${i}" aria-label="Карта ${i + 1}">${cardBack()}</button>` : ''))
      .join('');
    return bar(game, store, 'Твоя очередь: тяни карту', `<div class="ab-deck">${cards}</div>`, 'gold');
  }
  if (!me?.alive) return '';

  const speaking = game.speaker === me.seat;
  if (game.phase === 'day' && speaking) {
    const title = game.speakerMuted ? 'Твоя минута: молчишь (3 фола)' : 'Твоя минута';
    if (mode?.kind === 'nominate') {
      const sel = store.selected;
      const main = sel.length
        ? `<div class="grid2"><button class="btn ghost" data-act="pass">Пас</button><button class="btn red" data-act="confirm">Выставить №${sel[0]}</button></div>`
        : `<p class="ab-hint">Хочешь выставить? Нажми номер за столом</p><button class="btn gold" data-act="pass">Пас</button>`;
      return bar(game, store, title, main, 'gold');
    }
    return bar(game, store, title, '<button class="btn gold" data-act="pass">Пас</button>', 'gold');
  }
  if ((game.phase === 'tieSpeech' || game.phase === 'lastWord') && speaking) {
    const title = game.phase === 'tieSpeech' ? 'Твоё оправдание' : 'Твоя последняя минута';
    return bar(game, store, title, '<button class="btn gold" data-act="pass">Закончить</button>', 'gold');
  }
  if (game.phase === 'voting' && game.voting) {
    const v = game.voting;
    const c = v.candidates[v.index];
    if (v.votes[me.seat] === undefined && c !== undefined) {
      return bar(game, store, `Голосуем против №${c}`, `<button class="btn red" data-act="vote" data-n="${c}">Против №${c}</button>`, 'red');
    }
    return '';
  }
  if (game.phase === 'liftVote' && game.lift && !game.lift.yes.includes(me.seat)) {
    const who = game.lift.candidates.map((n) => '№' + n).join(' и ');
    return bar(game, store, `Поднять ${who}?`, '<button class="btn red" data-act="liftYes">За</button>', 'red');
  }
  if (game.phase === 'night' && mode) {
    if (mode.kind === 'shoot') return bar(game, store, 'Выбери цель', confirmButton(store, 'Выстрелить в', 'red', 'Нажми номер за столом'), 'red');
    if (mode.kind === 'check') {
      const title = me.role === 'don' ? 'Найди шерифа' : 'Проверь игрока';
      return bar(game, store, title, confirmButton(store, 'Проверить', 'gold', 'Нажми номер за столом'), 'gold');
    }
    if (mode.kind === 'bestMove') {
      const sel = store.selected;
      return bar(game, store, `Лучший ход: ${sel.length} из ${mode.max}`,
        `<button class="btn gold" data-act="confirm" ${sel.length ? '' : 'disabled'}>${sel.length ? `Отправить: ${sel.join(', ')}` : 'Нажми номера за столом'}</button>`, 'gold');
    }
  }
  return '';
}

// Меню стола «⋯» в шапке: правила, звук, выйти, распустить стол.
// Выход посреди партии и роспуск стола идут через окно подтверждения.

import type { Store } from '../store.ts';

const DOTS = '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2.2"/><circle cx="12" cy="12" r="2.2"/><circle cx="19" cy="12" r="2.2"/></svg>';

export function menuButton(): string {
  return `<button type="button" class="menu-btn" data-act="menu" aria-label="Меню стола">${DOTS}</button>`;
}

export function canDisband(store: Store): boolean {
  const room = store.room;
  return !!room && (room.you.kind === 'host' || room.you.owner);
}

/** Идёт партия, и выход оставит место пустым. */
export function inGame(store: Store): boolean {
  const g = store.game;
  return !!g && g.phase !== 'ended' && store.room?.you.kind !== 'spectator';
}

function sheet(label: string, body: string): string {
  return `<div class="sheet-backdrop" data-act="sheetClose"></div>
    <div class="sheet menu-sheet" role="dialog" aria-modal="true" aria-label="${label}">
      <button type="button" class="sheet-close" data-act="sheetClose" aria-label="Закрыть">✕</button>
      ${body}
    </div>`;
}

export function menuSheets(store: Store): string {
  if (store.confirm === 'leave') {
    const host = store.room?.you.kind === 'host';
    return sheet('Выйти из партии', `<h2>Выйти из партии?</h2>
      <p class="note">${host ? 'Партия останется без ведущего. Таймеры встанут, пока ты не вернёшься.' : 'Твоё место останется пустым, вернуться в эту партию уже не получится.'}</p>
      <div class="grid2"><button class="btn" data-act="sheetClose">Остаться</button><button class="btn red" data-act="leave">Выйти</button></div>`);
  }
  if (store.confirm === 'disband') {
    return sheet('Распустить стол', `<h2>Распустить стол?</h2>
      <p class="note">Игра закончится для всех, стол закроется. Это не отменить.</p>
      <div class="grid2"><button class="btn" data-act="sheetClose">Отмена</button><button class="btn red" data-act="disband">Распустить</button></div>`);
  }
  if (!store.menu) return '';
  return sheet('Меню стола', `<h2>Стол ${store.room?.code ?? ''}</h2>
    <div class="menu-list">
      <button class="menu-item" data-act="rules"><span>Правила</span><small>роли, день и ночь</small></button>
      <button class="menu-item" data-act="soundToggle" aria-pressed="${store.sound}"><span>Звук</span><small>сигнал, когда твоя очередь</small><i class="switch"></i></button>
      <button class="menu-item" data-act="${inGame(store) ? 'askLeave' : 'leave'}"><span>Выйти из-за стола</span><small>${inGame(store) ? 'место в партии останется пустым' : 'вернёшься на главный экран'}</small></button>
      ${canDisband(store) ? '<button class="menu-item danger" data-act="askDisband"><span>Распустить стол</span><small>игра закончится для всех</small></button>' : ''}
    </div>`);
}

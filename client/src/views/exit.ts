// Кнопки внизу экрана: выйти самому и распустить стол (ведущий или создатель комнаты).

import type { Store } from '../store.ts';

export function exitButtons(store: Store): string {
  const room = store.room;
  const canDisband = !!room && (room.you.kind === 'host' || room.you.owner);
  const armed = store.disbandArmed;
  return `<div class="exit-row${canDisband ? '' : ' single'}">
    <button class="btn ghost" data-act="leave">Выйти из комнаты</button>
    ${canDisband ? `<button class="btn ${armed ? 'red' : 'outline-red'}" data-act="disband">${armed ? 'Точно распустить?' : 'Распустить стол'}</button>` : ''}
  </div>
  ${canDisband && armed ? '<p class="hint">Игра закончится для всех, комната закроется. Нажмите ещё раз, чтобы подтвердить.</p>' : ''}`;
}

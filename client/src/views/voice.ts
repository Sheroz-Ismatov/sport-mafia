// Плашка голоса внизу экрана и подсветка тех, кто сейчас говорит.

import type { RoomInfo } from '../../../server/protocol.ts';
import type { GameView } from '../../../engine/index.ts';
import type { VoiceState } from '../voice.ts';
import { esc } from '../util.ts';

const MIC = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg>';
const MIC_OFF = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M4 4l16 16"/></svg>';
const EAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="3" y="13" width="4" height="7" rx="1.5"/><rect x="17" y="13" width="4" height="7" rx="1.5"/></svg>';

/** Почему микрофон закрыт: короткая подсказка по фазе игры. */
function closedReason(game: GameView | null): string {
  if (!game) return '';
  if (['day', 'tieSpeech', 'lastWord'].includes(game.phase) && game.speaker !== null) return `слово у №${game.speaker}`;
  if (game.phase === 'night' || game.phase === 'zeroNight') return 'ночь, город молчит';
  if (game.phase === 'voting' || game.phase === 'liftVote') return 'идёт голосование';
  if (game.phase === 'deal') return 'раздача карт';
  return '';
}

function talkingText(room: RoomInfo, v: VoiceState): string {
  const names = room.members
    .filter((m) => v.talking.has(m.id) && m.id !== room.you.id)
    .map((m) => (m.kind === 'host' ? 'ведущий' : m.seat ? `№${m.seat}` : esc(m.nick)));
  return names.length ? `Говорит: ${names.join(', ')}` : '';
}

export function renderVoice(room: RoomInfo | null, game: GameView | null, v: VoiceState, canSpeak: boolean): string {
  if (!room?.voice) return '';
  const listener = room.you.kind === 'spectator' || (game !== null && game.phase !== 'ended' && room.you.kind === 'player' && room.you.seat !== null && game.seats[room.you.seat - 1]?.alive === false);

  if (v.status === 'off' || v.status === 'error') {
    return `<div class="voice off" role="region" aria-label="Голос">
      <button class="btn small voice-on" data-act="voiceOn">${listener ? EAR : MIC}<span>Включить голос</span></button>
      ${v.error ? `<span class="voice-msg err">${esc(v.error)}</span>` : `<span class="voice-msg">${listener ? 'Чтобы слышать игру' : 'Чтобы говорить и слышать стол'}</span>`}
    </div>`;
  }
  if (v.status !== 'on') {
    return '<div class="voice" role="status" aria-label="Голос"><span class="voice-msg">Подключаю голос…</span></div>';
  }

  const talking = talkingText(room, v);
  let state: string;
  let button = '';
  if (canSpeak) {
    const host = room.you.kind === 'host';
    if (v.selfMuted) state = `<span class="voice-state muted">${MIC_OFF}<span>Микрофон выключен</span></span>`;
    else if (v.micOn) state = `<span class="voice-state live${v.talking.has(room.you.id) ? ' loud' : ''}">${MIC}<span>${host ? 'Вас слышат все' : 'Ваше слово, вас слышат'}</span></span>`;
    else state = `<span class="voice-state">${MIC}<span>Открываю микрофон…</span></span>`;
    button = `<button class="btn tiny" data-act="voiceMute">${v.selfMuted ? 'Включить микрофон' : 'Выключить'}</button>`;
  } else if (listener) {
    state = `<span class="voice-state">${EAR}<span>Вы слушаете</span></span>`;
  } else {
    const why = closedReason(game);
    state = `<span class="voice-state muted">${MIC_OFF}<span>Микрофон закрыт${why ? ` · ${why}` : ''}</span></span>`;
  }

  return `<div class="voice on" role="region" aria-label="Голос">
    ${state}
    ${talking ? `<span class="voice-msg">${talking}</span>` : ''}
    ${v.error ? `<span class="voice-msg err">${esc(v.error)}</span>` : ''}
    <span class="voice-btns">
      ${v.needsTap ? '<button class="btn tiny primary" data-act="voiceTap">Включить звук</button>' : ''}
      ${button}
      <button class="btn tiny ghost" data-act="voiceOff" aria-label="Выйти из голоса">Выйти</button>
    </span>
  </div>`;
}

/** Подсвечивает места тех, кто говорит прямо сейчас (по звуку, а не по правилам). */
export function markTalking(root: HTMLElement, room: RoomInfo | null, talking: Set<string>): void {
  const seats = new Set<number>();
  for (const m of room?.members ?? []) if (talking.has(m.id) && m.seat) seats.add(m.seat);
  for (const el of root.querySelectorAll<HTMLElement>('[data-vseat]')) {
    el.classList.toggle('talking', seats.has(Number(el.dataset.vseat)));
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-vid]')) {
    el.classList.toggle('talking', talking.has(el.dataset.vid ?? ''));
  }
}

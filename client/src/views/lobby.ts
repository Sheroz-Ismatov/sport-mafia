// Главный экран (создать или войти) и лобби комнаты.

import type { Store } from '../store.ts';
import { esc, seatPosition } from '../util.ts';
import { memberAvatar } from './home.ts';
import { menuButton } from './exit.ts';
import { inTelegram, telegramLink } from '../tg.ts';
import { MAX_PLAYERS, MIN_PLAYERS, roleCounts } from '../../../engine/types.ts';

/** «8 игроков: 5 мирных, шериф, дон и мафия» */
function composition(n: number): string {
  if (n < MIN_PLAYERS) return `Нужно хотя бы ${MIN_PLAYERS} игроков, сейчас ${n}`;
  const c = roleCounts(n);
  const blacks = c.mafia === 1 ? 'дон и мафия' : `дон и ${c.mafia} мафии`;
  return `${n} игроков: ${c.civilian} мирных, шериф, ${blacks}${n < MAX_PLAYERS ? '. Неполный стол: чёрных двое' : ''}`;
}

/** Круглый стол в лобби: игроки по порядку входа, пустые места пунктиром. Места разыграются при старте. */
function lobbyTable(store: Store): string {
  const room = store.room!;
  const players = room.members.filter((m) => m.kind === 'player');
  const host = room.members.find((m) => m.kind === 'host');
  const seats = Array.from({ length: MAX_PLAYERS }, (_, i) => {
    const pos = seatPosition(i + 1, MAX_PLAYERS);
    const m = players[i];
    const style = `left:${pos.left}%;top:${pos.top}%`;
    if (!m) return `<div class="lseat empty" style="${style}"><span class="plus">+</span><small>свободно</small></div>`;
    const cls = ['lseat'];
    if (m.id === room.you.id) cls.push('me');
    if (!m.connected) cls.push('off');
    return `<div class="${cls.join(' ')}" style="${style}" data-vid="${esc(m.id)}">${memberAvatar(m, 34)}<small>${m.id === room.you.id ? 'ты' : esc(m.nick)}</small></div>`;
  }).join('');
  const need = Math.max(0, MIN_PLAYERS - players.length);
  return `<div class="table lobby-table">${seats}
    <div class="table-center">
      <span class="lbl">За столом</span>
      <span class="lobby-count">${players.length}<small>/${MAX_PLAYERS}</small></span>
      <span class="sub">${need ? `ещё ${need} до старта` : players.length < MAX_PLAYERS ? 'можно начинать' : 'стол полный'}</span>
      ${host ? `<span class="lobby-host" data-vid="${esc(host.id)}">${memberAvatar(host, 22)}<small>ведущий ${host.id === room.you.id ? '(ты)' : esc(host.nick)}</small></span>` : ''}
    </div>
  </div>`;
}

function inviteCard(store: Store, link: string, tgLink: string | null, main: boolean): string {
  const room = store.room!;
  const p = main ? 'primary' : '';
  const buttons = tgLink
    ? `<div class="grid2">
        <button class="btn small ${p}" data-act="invite" data-v="${esc(tgLink)}">${inTelegram ? 'Позвать друзей' : 'Ссылка в Telegram'}</button>
        <button class="btn small" data-act="invite" data-spectator="1" data-v="${esc(telegramLink(store.config, room.code, true)!)}">Для зрителей</button>
      </div>
      <button class="btn small ghost" data-act="copyLink" data-v="${esc(link)}">Ссылка для браузера</button>`
    : `<div class="grid2">
        <button class="btn small ${p}" data-act="copyLink" data-v="${esc(link)}">Позвать друзей</button>
        <button class="btn small" data-act="copyLink" data-v="${esc(link + '&as=spectator')}">Для зрителей</button>
      </div>`;
  return `<div class="card invite${main ? ' accent' : ''}">
    <div class="invite-code"><span class="eyebrow">Код стола</span><span class="code-big">${esc(room.code)}</span></div>
    ${buttons}
  </div>`;
}

export function renderLobby(store: Store): string {
  const room = store.room!;
  const isHost = room.you.owner;
  const link = `${location.origin}/?room=${encodeURIComponent(room.code)}`;
  const tgLink = telegramLink(store.config, room.code);
  const players = room.members.filter((m) => m.kind === 'player');
  const spectators = room.members.filter((m) => m.kind === 'spectator');
  const who = room.you.kind === 'host' ? 'Ты ведущий' : room.you.kind === 'spectator' ? 'Ты зритель' : 'Ты игрок';
  const need = Math.max(0, MIN_PLAYERS - players.length);
  const enough = need === 0;
  // Одна главная кнопка: пока игроков мало, главное позвать друзей; когда хватает, раздать карты
  const inviteMain = !isHost || !enough;

  return `<div class="screen lobby">
    <div class="top"><div class="top-left"><span class="eyebrow">${who}${room.you.owner && room.you.kind !== 'host' ? ' и создатель стола' : ''}</span><h1>Собираем стол</h1></div>${menuButton()}</div>
    ${lobbyTable(store)}
    ${inviteCard(store, link, tgLink, inviteMain)}
    ${isHost ? `<div class="stack">
      <button class="btn ${inviteMain ? '' : 'primary'} start-btn" data-act="start" ${enough ? '' : 'disabled'}>
        <b>Раздать карты</b>${enough ? '' : `<small>${need === 1 ? 'ещё 1 игрок' : need < 5 ? `ещё ${need} игрока` : `ещё ${need} игроков`}</small>`}</button>
      <p class="hint center">${composition(players.length)}</p>
      ${players.length < MAX_PLAYERS ? `<button class="btn ghost small" data-act="addBots">Добрать ботами до ${MAX_PLAYERS} (+${MAX_PLAYERS - players.length})</button>` : ''}
    </div>` : `<p class="hint center">${composition(players.length)}. Ждём, пока создатель стола раздаст карты, места разыграются случайно.</p>`}
    ${spectators.length ? `<div class="spectators"><span class="k">Зрители</span><span class="faces">${spectators.slice(0, 8).map((m) => `<span title="${esc(m.nick)}">${memberAvatar(m, 26)}</span>`).join('')}${spectators.length > 8 ? `<small>+${spectators.length - 8}</small>` : ''}</span></div>` : ''}
  </div>`;
}

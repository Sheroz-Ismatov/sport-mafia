// Главный экран (создать или войти) и лобби комнаты.

import type { Store } from '../store.ts';
import { esc } from '../util.ts';
import { exitButtons } from './exit.ts';
import { accountCard } from './profile.ts';
import { inTelegram, telegramLink } from '../tg.ts';
import { MAX_PLAYERS, MIN_PLAYERS, roleCounts } from '../../../engine/types.ts';

/** «8 игроков: 5 мирных, шериф, дон и мафия» */
function composition(n: number): string {
  if (n < MIN_PLAYERS) return `Нужно хотя бы ${MIN_PLAYERS} игроков, сейчас ${n}`;
  const c = roleCounts(n);
  const blacks = c.mafia === 1 ? 'дон и мафия' : `дон и ${c.mafia} мафии`;
  return `${n} игроков: ${c.civilian} мирных, шериф, ${blacks}${n < MAX_PLAYERS ? '. Неполный стол: чёрных двое' : ''}`;
}

export function renderHome(store: Store): string {
  const joining = store.code !== '';
  return `<div class="screen">
    <div class="top-left"><span class="eyebrow">Онлайн-стол на ${MIN_PLAYERS}-${MAX_PLAYERS} игроков</span><h1>Спортивная мафия</h1></div>
    ${accountCard(store)}
    <div class="field"><label for="nick">Ваш ник</label>
      <input id="nick" data-model="nick" maxlength="24" autocomplete="nickname" value="${esc(store.nick)}" placeholder="Например, Лео"></div>
    <div class="card">
      <h2>Войти в комнату</h2>
      <div class="field"><label for="code">Код комнаты</label>
        <input id="code" class="code-input" data-model="code" maxlength="12" value="${esc(store.code)}" placeholder="MAF-4821" autocapitalize="characters"></div>
      <div class="seg" role="group" aria-label="Как войти">
        <button type="button" data-act="joinAs" data-v="player" aria-pressed="${store.joinAs === 'player'}">Игроком</button>
        <button type="button" data-act="joinAs" data-v="spectator" aria-pressed="${store.joinAs === 'spectator'}">Зрителем</button>
      </div>
      <button class="btn primary" data-act="join">Войти</button>
    </div>
    ${store.prevSession ? `<div class="card">
      <p class="note">Вы открыли приглашение в комнату ${esc(store.code)}. У вас есть незаконченная игра в ${esc(store.prevSession.code)}.</p>
      <button class="btn small" data-act="backToPrev">Вернуться в ${esc(store.prevSession.code)}</button>
    </div>` : ''}
    ${joining ? '' : `<div class="card">
      <h2>Новая комната</h2>
      <button class="btn" data-act="create" data-v="host">Создать и вести игру</button>
      <p class="hint">Вы ведущий: следите за временем и фолами, видите все роли.</p>
      <button class="btn" data-act="create" data-v="player">Создать и играть самому</button>
      <p class="hint">Вы за столом как игрок. Ведущего нет: таймеры идут сами, фолы не выдаются. Удобно, чтобы сыграть с ботами.</p>
    </div>`}
  </div>`;
}

export function renderLobby(store: Store): string {
  const room = store.room!;
  const isHost = room.you.owner;
  const link = `${location.origin}/?room=${encodeURIComponent(room.code)}`;
  const tgLink = telegramLink(store.config, room.code);
  const players = room.members.filter((m) => m.kind === 'player');
  const spectators = room.members.filter((m) => m.kind === 'spectator');
  const host = room.members.find((m) => m.kind === 'host');
  const item = (m: (typeof room.members)[number]) =>
    `<div class="member" data-vid="${esc(m.id)}"><span class="dotc ${m.connected ? '' : 'off'}"></span><span>${esc(m.nick)}</span>
      <small>${m.bot ? 'бот' : m.id === room.you.id ? 'вы' : m.connected ? '' : 'не в сети'}</small></div>`;

  return `<div class="screen">
    <div class="top"><div class="top-left"><span class="eyebrow">${room.you.kind === 'host' ? 'Вы ведущий' : room.you.kind === 'spectator' ? 'Вы зритель' : 'Вы игрок'}${room.you.owner && room.you.kind !== 'host' ? ' и создатель комнаты' : ''}</span><h1>Лобби</h1></div>
      <span class="pill gold">${players.length} из ${MAX_PLAYERS}</span></div>
    <div class="card accent">
      <span class="eyebrow">Код комнаты</span>
      <span class="code-big">${esc(room.code)}</span>
      ${tgLink ? `<div class="grid2">
        <button class="btn small primary" data-act="invite" data-v="${esc(tgLink)}">${inTelegram ? 'Позвать в Telegram' : 'Ссылка в Telegram'}</button>
        <button class="btn small" data-act="invite" data-v="${esc(telegramLink(store.config, room.code, true)!)}">Для зрителей</button>
      </div>
      <button class="btn small ghost" data-act="copyLink" data-v="${esc(link)}">Ссылка для браузера</button>` : `<div class="grid2">
        <button class="btn small" data-act="copyLink" data-v="${esc(link)}">Скопировать ссылку</button>
        <button class="btn small" data-act="copyLink" data-v="${esc(link + '&as=spectator')}">Ссылка для зрителей</button>
      </div>`}
    </div>
    ${isHost ? `<div class="stack">
      <p class="note">${composition(players.length)}</p>
      <button class="btn primary" data-act="start" ${players.length >= MIN_PLAYERS ? '' : 'disabled'}>Начать раздачу карт</button>
      ${players.length < MAX_PLAYERS ? `<button class="btn" data-act="addBots">Добрать ботами до ${MAX_PLAYERS} (+${MAX_PLAYERS - players.length})</button>
      <p class="hint">Играть можно от ${MIN_PLAYERS} человек без ботов. Боты ходят случайно, они нужны для проверки.</p>` : ''}
    </div>` : `<p class="note">${composition(players.length)}</p>
      <p class="hint">Ждём, пока создатель комнаты начнёт игру. Места за столом разыграются случайно.</p>`}
    <div class="stack"><h2>Ведущий</h2>${host ? `<div class="members">${item(host)}</div>` : '<p class="hint">Без ведущего: таймеры идут сами, фолов и удалений нет.</p>'}</div>
    <div class="stack"><h2>Игроки</h2><div class="members">${players.map(item).join('') || '<p class="hint">Пока никого</p>'}</div></div>
    ${spectators.length ? `<div class="stack"><h2>Зрители</h2><div class="members">${spectators.map(item).join('')}</div></div>` : ''}
    ${exitButtons(store)}
  </div>`;
}

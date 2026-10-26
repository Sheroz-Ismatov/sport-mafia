// Главный экран: фраза Дона, «Создать стол» и «Войти по коду» (в выезжающих окнах), статистика, правила.

import type { Store } from '../store.ts';
import type { ApiUser } from '../../../server/protocol.ts';
import { ROLE_NAME, esc } from '../util.ts';
import { QUOTES } from '../quotes.ts';
import { inTelegram } from '../tg.ts';
import { MAX_PLAYERS, MIN_PLAYERS } from '../../../engine/types.ts';

const QUOTE_ART: Record<string, string> = {
  don: '/img/don.webp', mafia: '/img/mafia.webp', sheriff: '/img/sheriff.webp', civilian: '/img/civilian.webp',
  host: '/img/logo.webp', saying: '/img/logo.webp',
};

export function avatar(u: Pick<ApiUser, 'firstName' | 'photoUrl'>, size = 44): string {
  const letter = esc((u.firstName || '?').slice(0, 1).toUpperCase());
  const img = u.photoUrl && /^https:\/\//.test(u.photoUrl)
    ? `<img src="${esc(u.photoUrl)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">`
    : '';
  return `<span class="avatar" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px" aria-hidden="true">${letter}${img}</span>`;
}

function quoteCard(store: Store): string {
  const q = QUOTES[store.quote] ?? QUOTES[0];
  return `<button type="button" class="quote" data-act="nextQuote" aria-label="Следующая фраза">
    <span class="quote-art r-${q.role}"><img src="${QUOTE_ART[q.role]}" alt=""></span>
    <span class="quote-body"><span class="quote-text">«${esc(q.text)}»</span><span class="quote-by">${esc(q.by)}</span></span>
  </button>`;
}

function statsCard(store: Store): string {
  const acc = store.account;
  if (!acc) return '';
  const s = store.profile.stats;
  if (!s) return `<button type="button" class="stat-strip" data-act="profile"><span class="k">Твоя статистика</span><span class="v">загружаем…</span></button>`;
  if (!s.games) {
    return `<button type="button" class="stat-strip" data-act="profile"><span class="k">Твоя статистика</span>
      <span class="v">Сыграй первую партию без ботов, и здесь появятся победы по ролям</span></button>`;
  }
  const best = (Object.entries(s.roles) as [keyof typeof ROLE_NAME, { games: number; wins: number }][])
    .filter(([, x]) => x.games > 0)
    .sort((a, b) => b[1].wins / b[1].games - a[1].wins / a[1].games || b[1].games - a[1].games)[0];
  return `<button type="button" class="stat-strip" data-act="profile"><span class="k">Твоя статистика</span>
    <span class="v"><b>${s.games}</b> ${plural(s.games, 'партия', 'партии', 'партий')} · <b>${Math.round((s.wins / s.games) * 100)}%</b> побед${best ? ` · лучшая роль: <b class="t-${best[0]}">${ROLE_NAME[best[0]]}</b>` : ''}</span></button>`;
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function loginCard(store: Store): string {
  if (store.account || inTelegram || !store.config?.accounts || !store.config.telegram) return '';
  return `<div class="card login-card">
    <div><b>Копи статистику</b><p class="hint">Войди через Telegram, и все твои партии и победы по ролям сохранятся. Играть можно и без входа.</p></div>
    <div id="tg-login" class="tg-login"></div>
  </div>`;
}

function nickField(store: Store): string {
  return `<div class="field"><label for="nick">Как тебя называть за столом</label>
    <input id="nick" data-model="nick" maxlength="24" autocomplete="nickname" value="${esc(store.nick)}" placeholder="Например, Лео"></div>`;
}

function sheet(store: Store): string {
  if (!store.sheet) return '';
  let body: string;
  if (store.sheet === 'create') {
    body = `<h2>Новый стол</h2>
      ${nickField(store)}
      <button type="button" class="choice" data-act="create" data-v="host">
        <img src="/img/logo.webp" alt=""><span><b>Я ведущий</b><small>Веду игру: вижу все роли, слежу за временем, даю фолы</small></span></button>
      <button type="button" class="choice" data-act="create" data-v="player">
        <img src="/img/civilian.webp" alt=""><span><b>Играю сам</b><small>Сажусь за стол игроком. Ведущего нет, таймеры идут сами, можно добрать ботов</small></span></button>
      <p class="hint">Дальше получишь ссылку, которую можно отправить друзьям. За столом от ${MIN_PLAYERS} до ${MAX_PLAYERS} игроков.</p>`;
  } else {
    body = `<h2>Войти по коду</h2>
      ${nickField(store)}
      <div class="field"><label for="code">Код стола</label>
        <input id="code" class="code-input" data-model="code" maxlength="12" value="${esc(store.code)}" placeholder="MAF-4821" autocapitalize="characters" inputmode="text"></div>
      <div class="seg" role="group" aria-label="Как войти">
        <button type="button" data-act="joinAs" data-v="player" aria-pressed="${store.joinAs === 'player'}">Игроком</button>
        <button type="button" data-act="joinAs" data-v="spectator" aria-pressed="${store.joinAs === 'spectator'}">Зрителем</button>
      </div>
      <button class="btn primary" data-act="join">Сесть за стол</button>`;
  }
  return `<div class="sheet-backdrop" data-act="sheetClose"></div>
    <div class="sheet" role="dialog" aria-modal="true">
      <button type="button" class="sheet-close" data-act="sheetClose" aria-label="Закрыть">✕</button>
      ${body}
    </div>`;
}

export function renderHome(store: Store): string {
  const acc = store.account;
  const invite = store.code && !store.prevSession && !store.sheet;
  return `<div class="screen home">
    <header class="home-top">
      <div class="brand-mini"><img src="/img/logo.webp" alt="" width="48" height="48">
        <div><b>Спортивная мафия</b><small>онлайн-стол на ${MIN_PLAYERS}-${MAX_PLAYERS} котиков</small></div></div>
      ${acc ? `<button type="button" class="avatar-btn" data-act="profile" aria-label="Профиль">${avatar(acc.user, 40)}</button>` : ''}
    </header>
    ${quoteCard(store)}
    ${store.prevSession ? `<div class="card gold">
      <p class="note">У тебя есть незаконченная партия за столом ${esc(store.prevSession.code)}.</p>
      <button class="btn small" data-act="backToPrev">Вернуться за стол ${esc(store.prevSession.code)}</button>
    </div>` : ''}
    ${invite ? `<div class="card accent invite-card">
      <p class="note">Тебя позвали за стол <b>${esc(store.code)}</b></p>
      <button class="btn primary" data-act="sheet" data-v="join">Сесть за стол</button>
    </div>` : ''}
    <div class="home-actions">
      <button type="button" class="btn big ${invite ? '' : 'primary'}" data-act="sheet" data-v="create"><b>Создать стол</b><small>и позвать друзей по ссылке</small></button>
      <button type="button" class="btn big" data-act="sheet" data-v="join"><b>Войти по коду</b><small>если стол уже создали</small></button>
    </div>
    ${statsCard(store)}
    ${loginCard(store)}
    <button type="button" class="link-row" data-act="rules"><span><b>Как играть</b><small>роли, день и ночь за пару минут</small></span><span aria-hidden="true">→</span></button>
  </div>
  ${sheet(store)}`;
}

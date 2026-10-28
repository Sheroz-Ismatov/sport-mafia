// Профиль игрока: аккаунт Telegram и статистика по ролям. И плашка аккаунта на главном экране.

import type { Store } from '../store.ts';
import type { ApiUser } from '../../../server/protocol.ts';
import { ROLE_NAME, esc } from '../util.ts';
import { inTelegram } from '../tg.ts';

function avatar(u: ApiUser, size = 44): string {
  const letter = esc((u.firstName || '?').slice(0, 1).toUpperCase());
  const img = u.photoUrl && /^https:\/\//.test(u.photoUrl)
    ? `<img src="${esc(u.photoUrl)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">`
    : '';
  return `<span class="avatar" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px" aria-hidden="true">${letter}${img}</span>`;
}

const fullName = (u: ApiUser) => esc([u.firstName, u.lastName].filter(Boolean).join(' '));
const pct = (wins: number, games: number) => (games ? `${Math.round((wins / games) * 100)}%` : '—');

/** Плашка на главном экране: кто вошёл, или кнопка входа. */
export function accountCard(store: Store): string {
  const cfg = store.config;
  const acc = store.account;
  if (acc) {
    return `<div class="card account">
      <div class="account-row">${avatar(acc.user)}
        <div class="account-who"><b>${fullName(acc.user)}</b>${acc.user.username ? `<small>@${esc(acc.user.username)}</small>` : ''}</div>
        <button class="btn small" data-act="profile">Профиль</button>
      </div>
    </div>`;
  }
  if (store.authPending) return '<div class="card account"><p class="hint">Входим через Telegram…</p></div>';
  if (!cfg?.accounts || !cfg.telegram) return '';
  if (inTelegram) return '<div class="card account"><p class="hint">Не получилось войти через Telegram. Закрой игру и открой снова.</p></div>';
  return `<div class="card account">
    <h2>Статистика игр</h2>
    <p class="hint">Войди через Telegram, чтобы сохранялись твои партии и победы по ролям. Можно играть и без входа.</p>
    <div id="tg-login" class="tg-login"></div>
  </div>`;
}

export function renderProfile(store: Store): string {
  const acc = store.account!;
  const p = store.profile;
  const s = p.stats;
  let body: string;
  if (p.error) body = `<div class="card danger"><p class="note">${esc(p.error)}</p><button class="btn small" data-act="profile">Повторить</button></div>`;
  else if (!s) body = '<p class="hint">Загружаем статистику…</p>';
  else {
    const roles = (['civilian', 'sheriff', 'mafia', 'don'] as const).map((r) => {
      const x = s.roles[r];
      return `<div class="role-stat"><span class="t-${r}">${ROLE_NAME[r]}</span><b>${pct(x.wins, x.games)}</b><small>${x.wins} из ${x.games}</small></div>`;
    }).join('');
    const recent = s.recent.length
      ? s.recent.map((g) => {
        const res = g.winner === 'draw' ? 'ничья' : g.won ? 'победа' : 'поражение';
        const date = new Date(g.endedAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
        return `<div class="row"><span class="k">${date} · <span class="t-${esc(g.role)}">${ROLE_NAME[g.role as keyof typeof ROLE_NAME] ?? esc(g.role)}</span>${g.bots ? ' · с ботами' : ''}</span><span class="v ${g.won ? 'win' : ''}">${res}</span></div>`;
      }).join('')
      : '<p class="hint">Пока ни одной партии.</p>';
    body = `<div class="stat-big">
        <div><b>${s.games}</b><small>партий</small></div>
        <div><b>${pct(s.wins, s.games)}</b><small>побед</small></div>
        <div><b>${s.hosted}</b><small>провёл ведущим</small></div>
      </div>
      <div class="card"><h2>По ролям</h2><div class="role-grid">${roles}</div></div>
      <div class="card"><h2>Дисциплина</h2>
        <div class="row"><span class="k">Фолов за все партии</span><span class="v">${s.fouls}</span></div>
        <div class="row"><span class="k">Удалений</span><span class="v">${s.removed}</span></div>
        <div class="row"><span class="k">Ничьих</span><span class="v">${s.draws}</span></div>
      </div>
      <div class="card"><h2>Последние партии</h2>${recent}</div>
      ${s.withBots ? `<p class="hint">Партии с ботами (${s.withBots}) видны в списке, но в статистику не входят.</p>` : ''}`;
  }
  return `<div class="screen">
    <div class="top"><div class="top-left"><span class="eyebrow">Профиль</span><h1>${fullName(acc.user)}</h1></div>${avatar(acc.user, 56)}</div>
    ${body}
    <button class="btn" data-act="profileBack">Назад</button>
    ${inTelegram ? '' : '<button class="btn ghost" data-act="logout">Выйти из аккаунта</button>'}
  </div>`;
}

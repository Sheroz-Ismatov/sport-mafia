// Telegram: запуск внутри Telegram (Mini App), вход на сайте, запросы к API аккаунтов.

import type { ApiConfig, ApiUser } from '../../server/protocol.ts';

export interface Account { session: string; user: ApiUser }

export interface Stats {
  games: number;
  wins: number;
  draws: number;
  roles: Record<'civilian' | 'sheriff' | 'mafia' | 'don', { games: number; wins: number }>;
  fouls: number;
  removed: number;
  hosted: number;
  withBots: number;
  recent: { endedAt: string; role: string; won: boolean; winner: string; players: number; bots: number; seat: number }[];
}

interface TgWebApp {
  initData: string;
  ready(): void;
  expand(): void;
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
  openTelegramLink(url: string): void;
  switchInlineQuery?(query: string, chatTypes?: ('users' | 'bots' | 'groups' | 'channels')[]): void;
  disableVerticalSwipes?(): void;
  HapticFeedback?: {
    impactOccurred(style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void;
    notificationOccurred(type: 'error' | 'success' | 'warning'): void;
  };
  BackButton?: { show(): void; hide(): void; onClick(fn: () => void): void };
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TgWebApp };
    onTelegramAuth?: (user: Record<string, unknown>) => void;
  }
}

/**
 * Данные запуска Mini App. Telegram кладёт их в адрес после #, а приложение потом меняет адрес,
 * поэтому читаем один раз при старте.
 */
export const miniAppInitData: string | null = (() => {
  try {
    const hash = new URLSearchParams(location.hash.slice(1));
    return hash.get('tgWebAppData');
  } catch {
    return null;
  }
})();

export const inTelegram = miniAppInitData !== null;

let webApp: TgWebApp | null = null;

/** Подключает Telegram.WebApp: растягивает окно, красит шапку под тему игры. */
export function setupMiniApp(onReady?: () => void): void {
  if (!inTelegram) return;
  const s = document.createElement('script');
  s.src = 'https://telegram.org/js/telegram-web-app.js';
  s.onload = () => {
    webApp = window.Telegram?.WebApp ?? null;
    if (!webApp) return;
    webApp.ready();
    webApp.expand();
    webApp.setHeaderColor?.('#0E1014');
    webApp.setBackgroundColor?.('#0E1014');
    webApp.disableVerticalSwipes?.(); // свайп вниз не закрывает игру посреди партии
    webApp.BackButton?.onClick(() => backHandler?.());
    onReady?.();
  };
  document.head.appendChild(s);
}

/** Лёгкая вибрация в Telegram: твоя минута, тебя выставили, голосование, конец партии. */
export function haptic(kind: 'turn' | 'alert' | 'tap' | 'win' | 'lose'): void {
  const h = webApp?.HapticFeedback;
  if (!h) {
    // Обычный браузер: вибрация через navigator.vibrate (Android; iPhone её не умеет)
    const pattern = { turn: [180], alert: [80, 60, 80], tap: [30], win: [60, 40, 120], lose: [200] }[kind];
    try { navigator.vibrate?.(pattern); } catch { /* нет вибрации */ }
    return;
  }
  try {
    if (kind === 'turn') h.impactOccurred('heavy');
    else if (kind === 'tap') h.impactOccurred('light');
    else if (kind === 'alert') h.notificationOccurred('warning');
    else h.notificationOccurred(kind === 'win' ? 'success' : 'error');
  } catch {
    // старая версия Telegram: без вибрации
  }
}

let backHandler: (() => void) | null = null;
let backShown = false;

/** Системная кнопка «Назад» в шапке Telegram (вместо поиска кнопки внизу страницы). */
export function setBackButton(onBack: (() => void) | null): void {
  backHandler = onBack;
  const bb = webApp?.BackButton;
  if (!bb) return;
  if (onBack && !backShown) bb.show();
  if (!onBack && backShown) bb.hide();
  backShown = !!onBack;
}

/** Поделиться ссылкой через окно выбора чата Telegram. */
export function shareInTelegram(link: string, text: string): boolean {
  if (!webApp) return false;
  webApp.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`);
  return true;
}

/**
 * Позвать друзей карточкой от бота: Telegram открывает выбор чата и вставляет карточку
 * с картинкой и кнопкой «Сесть за стол». Работает, если у бота включён inline-режим.
 */
export function inviteViaBot(query: string): boolean {
  if (!webApp?.switchInlineQuery) return false;
  try {
    webApp.switchInlineQuery(query, ['users', 'groups']);
    return true;
  } catch {
    return false;
  }
}

/** Дополнительные параметры запуска из бота: G12 — стол для сбора №12, rules — сразу правила. */
export function parseLaunchExtra(p: string | null): { gathering: number | null; rules: boolean } {
  const g = /^G(\d+)$/.exec(p ?? '');
  return { gathering: g ? Number(g[1]) : null, rules: p === 'rules' };
}

/** Код стола из приглашения t.me/бот/игра?startapp=MAF-1234 (зрителем: MAF-1234-s). */
export function parseStartParam(p: string | null): { code: string; spectator: boolean } | null {
  const m = /^(MAF-\d{4})(-s)?$/i.exec(p ?? '');
  return m ? { code: m[1].toUpperCase(), spectator: !!m[2] } : null;
}

export function telegramLink(cfg: ApiConfig | null, code: string, spectator = false): string | null {
  const tg = cfg?.telegram;
  if (!tg?.app) return null;
  return `https://t.me/${tg.bot}/${tg.app}?startapp=${encodeURIComponent(code + (spectator ? '-s' : ''))}`;
}

// ---------- API ----------

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error ?? 'Ошибка сервера'), { status: res.status });
  return body as T;
}

export const api = {
  config: () => call<ApiConfig>('/api/config'),
  authMiniApp: (initData: string) =>
    call<Account & { startParam: string | null }>('/api/auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ initData }) }),
  authWidget: (widget: Record<string, unknown>) =>
    call<Account & { startParam: null }>('/api/auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ widget }) }),
  me: (session: string) => call<{ user: ApiUser; stats: Stats }>('/api/me', { headers: { authorization: `Bearer ${session}` } }),
};

/** Кнопка «Войти через Telegram» на сайте. Нужен домен сайта в настройках бота (/setdomain). */
export function mountLoginWidget(el: HTMLElement, bot: string, onAuth: (user: Record<string, unknown>) => void): void {
  if (el.dataset.mounted === bot) return;
  el.dataset.mounted = bot;
  el.replaceChildren();
  window.onTelegramAuth = onAuth;
  const s = document.createElement('script');
  s.async = true;
  s.src = 'https://telegram.org/js/telegram-widget.js?22';
  s.dataset.telegramLogin = bot;
  s.dataset.size = 'large';
  s.dataset.radius = '12';
  s.dataset.onauth = 'onTelegramAuth(user)';
  el.appendChild(s);
}

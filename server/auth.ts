// Вход через Telegram: внутри Telegram (Mini App) и на сайте (кнопка «Войти через Telegram»).
// Telegram подписывает данные пользователя токеном бота, сервер проверяет подпись и выдаёт свою сессию.
//
// Переменные окружения (на Render: Environment):
//   TELEGRAM_BOT_TOKEN     токен бота от @BotFather
//   TELEGRAM_BOT_USERNAME  имя бота без @, например sport_mafia_bot
//   TELEGRAM_APP_NAME      короткое имя Mini App из /newapp, например play (для ссылок t.me/бот/play)

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface TelegramConfig {
  botToken: string;
  botUsername: string;
  appName: string | null;
}

export function telegramConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TelegramConfig | null {
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
  const botUsername = env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, '');
  if (!botToken || !botUsername) return null;
  return { botToken, botUsername, appName: env.TELEGRAM_APP_NAME?.trim() || null };
}

/** Кто вошёл: данные из Telegram. */
export interface TgUser {
  tgId: number;
  firstName: string;
  lastName: string | null;
  username: string | null;
  photoUrl: string | null;
}

const DAY = 24 * 3600;

function sameHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

function checkString(fields: Map<string, string>): string {
  return [...fields.keys()].filter((k) => k !== 'hash').sort().map((k) => `${k}=${fields.get(k)}`).join('\n');
}

function freshEnough(authDate: unknown, nowSec: number, maxAgeSec: number): boolean {
  const t = Number(authDate);
  return Number.isFinite(t) && t <= nowSec + 60 && nowSec - t <= maxAgeSec;
}

function toUser(raw: Record<string, unknown>): TgUser {
  const id = Number(raw.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Нет id пользователя');
  const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : null);
  return { tgId: id, firstName: s(raw.first_name) ?? 'Игрок', lastName: s(raw.last_name), username: s(raw.username), photoUrl: s(raw.photo_url) };
}

/** Данные из Mini App (Telegram.WebApp.initData). Возвращает пользователя и start_param или бросает ошибку. */
export function verifyInitData(initData: string, botToken: string, nowSec = Math.floor(Date.now() / 1000), maxAgeSec = DAY): { user: TgUser; startParam: string | null } {
  const params = new URLSearchParams(initData);
  const fields = new Map<string, string>();
  for (const [k, v] of params) fields.set(k, v);
  const hash = fields.get('hash') ?? '';
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(checkString(fields)).digest('hex');
  if (!sameHex(hash, expected)) throw new Error('Подпись Telegram не сходится');
  if (!freshEnough(fields.get('auth_date'), nowSec, maxAgeSec)) throw new Error('Данные Telegram устарели, откройте игру заново');
  const user = toUser(JSON.parse(fields.get('user') ?? '{}'));
  return { user, startParam: fields.get('start_param') ?? null };
}

/** Данные из кнопки «Войти через Telegram» на сайте (Telegram Login Widget). */
export function verifyLoginWidget(data: Record<string, unknown>, botToken: string, nowSec = Math.floor(Date.now() / 1000), maxAgeSec = DAY): TgUser {
  const fields = new Map<string, string>();
  for (const [k, v] of Object.entries(data)) if (v !== undefined && v !== null) fields.set(k, String(v));
  const secret = createHash('sha256').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(checkString(fields)).digest('hex');
  if (!sameHex(fields.get('hash') ?? '', expected)) throw new Error('Подпись Telegram не сходится');
  if (!freshEnough(fields.get('auth_date'), nowSec, maxAgeSec)) throw new Error('Вход устарел, попробуйте ещё раз');
  return toUser(data);
}

// ---------- Сессии ----------
// Своя подпись сервера: id игрока и срок. Ключ получается из токена бота, отдельный секрет не нужен.

const SESSION_DAYS = 60;

function sessionKey(botToken: string): Buffer {
  return createHmac('sha256', 'sport-mafia-session').update(botToken).digest();
}

export function signSession(userId: number, botToken: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const body = Buffer.from(JSON.stringify({ u: userId, exp: nowSec + SESSION_DAYS * DAY })).toString('base64url');
  const sig = createHmac('sha256', sessionKey(botToken)).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/** id игрока из сессии или null, если сессия поддельная или истекла. */
export function readSession(token: unknown, botToken: string, nowSec = Math.floor(Date.now() / 1000)): number | null {
  if (typeof token !== 'string' || token.length > 500) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', sessionKey(botToken)).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const { u, exp } = JSON.parse(Buffer.from(body, 'base64url').toString());
    return Number.isSafeInteger(u) && typeof exp === 'number' && exp > nowSec ? u : null;
  } catch {
    return null;
  }
}

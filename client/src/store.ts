// Всё состояние интерфейса в одном месте. Любое изменение → render().

import type { GameView } from '../../engine/index.ts';
import type { ApiConfig, Gender, RoomInfo } from '../../server/protocol.ts';
import type { Account, Stats } from './tg.ts';
import { miniAppInitData, parseStartParam } from './tg.ts';
import { randomQuoteIndex } from './quotes.ts';

export interface Session { code: string; token: string }

export interface Store {
  online: boolean;
  everConnected: boolean;
  session: Session | null;
  room: RoomInfo | null;
  game: GameView | null;
  offset: number;            // время сервера минус время телефона
  toast: string | null;
  // формы на главном экране
  nick: string;
  gender: Gender; // парень, девушка или трансформер: от этого зависят рисунки карт
  code: string;
  fieldError: { nick?: string; code?: string }; // подсказки прямо под полями в окне входа
  joinAs: 'player' | 'spectator';
  // выбор номеров за столом (выставить, выстрелить, проверить, лучший ход)
  selected: number[];
  selectKey: string;
  // ведущий
  hostTab: 'table' | 'night' | 'log';
  ppkArmed: number | null;
  removeArmed: number | null;
  hostSeat: number | null; // ведущий открыл окно места: фолы, удаление, ППК
  showLog: boolean;
  roleHidden: boolean; // своя роль в шапке скрыта (вдруг кто-то смотрит в экран)
  memoOpen: boolean; // записка семьи у чёрных развёрнута днём (сворачивается при смене фазы)
  cardHidden: boolean; // своя карта на раздаче перевёрнута рубашкой вверх
  menu: boolean;                         // открыто меню стола «⋯»
  confirm: 'leave' | 'disband' | null;   // окно подтверждения выхода или роспуска
  sound: boolean;                        // звуковой сигнал «твоя очередь»
  prevSession: Session | null; // запомненная игра, когда открыли ссылку на другой стол
  // аккаунт
  config: ApiConfig | null;      // что умеет сервер: Telegram, статистика
  account: Account | null;       // вошёл через Telegram
  authPending: boolean;          // внутри Telegram ждём проверки входа
  autoJoin: boolean;             // открыли приглашение в Telegram: сесть за стол сразу
  screen: 'main' | 'profile' | 'rules';
  sheet: 'create' | 'join' | null; // выезжающее окно на главном экране
  quote: number;                    // какая фраза Дона на главном экране
  profile: { stats: Stats | null; error: string | null; loading: boolean };
}

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // приватный режим браузера: просто не запоминаем
  }
}

const params = new URLSearchParams(location.search);

// Внутри Telegram: ник и приглашение берём из данных запуска (подпись проверит сервер)
const tgLaunch = (() => {
  if (!miniAppInitData) return null;
  try {
    const p = new URLSearchParams(miniAppInitData);
    const user = JSON.parse(p.get('user') ?? '{}') as { first_name?: string };
    return { name: (user.first_name ?? '').slice(0, 24), invite: parseStartParam(p.get('start_param')) };
  } catch {
    return null;
  }
})();

export const store: Store = {
  online: false,
  everConnected: false,
  session: load<Session | null>('mafia.session', null),
  room: null,
  game: null,
  offset: 0,
  toast: null,
  nick: load<string>('mafia.nick', '') || tgLaunch?.name || '',
  gender: load<Gender>('mafia.gender', 'm'),
  code: tgLaunch?.invite?.code ?? (params.get('room') ?? '').toUpperCase(),
  fieldError: {},
  joinAs: tgLaunch?.invite ? (tgLaunch.invite.spectator ? 'spectator' : 'player') : params.get('as') === 'spectator' ? 'spectator' : 'player',
  selected: [],
  selectKey: '',
  hostTab: 'table',
  ppkArmed: null,
  removeArmed: null,
  hostSeat: null,
  showLog: false,
  memoOpen: false,
  roleHidden: load<boolean>('mafia.roleHidden', false),
  cardHidden: false,
  menu: false,
  confirm: null,
  sound: load<boolean>('mafia.sound', true),
  prevSession: null,
  config: null,
  account: miniAppInitData ? null : load<Account | null>('mafia.account', null),
  authPending: miniAppInitData !== null,
  autoJoin: !!tgLaunch?.invite,
  screen: 'main',
  sheet: null,
  quote: randomQuoteIndex(),
  profile: { stats: null, error: null, loading: false },
};

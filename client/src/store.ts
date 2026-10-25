// Всё состояние интерфейса в одном месте. Любое изменение → render().

import type { GameView } from '../../engine/index.ts';
import type { RoomInfo } from '../../server/protocol.ts';

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
  code: string;
  joinAs: 'player' | 'spectator';
  // выбор номеров за столом (выставить, выстрелить, проверить, лучший ход)
  selected: number[];
  selectKey: string;
  // ведущий
  hostTab: 'table' | 'night' | 'log';
  ppkArmed: number | null;
  removeArmed: number | null;
  showLog: boolean;
  cardHidden: boolean; // своя карта на раздаче перевёрнута рубашкой вверх
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

export const store: Store = {
  online: false,
  everConnected: false,
  session: load<Session | null>('mafia.session', null),
  room: null,
  game: null,
  offset: 0,
  toast: null,
  nick: load<string>('mafia.nick', ''),
  code: (params.get('room') ?? '').toUpperCase(),
  joinAs: params.get('as') === 'spectator' ? 'spectator' : 'player',
  selected: [],
  selectKey: '',
  hostTab: 'table',
  ppkArmed: null,
  removeArmed: null,
  showLog: false,
  cardHidden: false,
};

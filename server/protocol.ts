// Сообщения между браузером и сервером. Всё ходит в JSON по WebSocket.

import type { Action, GameView } from '../engine/index.ts';

export type MemberKind = 'host' | 'player' | 'spectator';

/** Браузер → сервер */
export type ClientMessage =
  | { t: 'create'; nick: string; as?: 'host' | 'player'; session?: string } // создать комнату: вести игру или играть самому (тогда без ведущего)
  | { t: 'join'; code: string; nick: string; as: 'player' | 'spectator'; session?: string } // войти по коду; session — вход через Telegram
  | { t: 'resume'; code: string; token: string }                          // вернуться после обрыва связи
  | { t: 'addBots' }                                                      // создатель: добрать стол ботами (для проверки)
  | { t: 'start' }                                                        // создатель: раздать карты
  | { t: 'restart' }                                                      // создатель: новая партия после окончания
  | { t: 'act'; action: Action }                                          // ход в игре
  | { t: 'leave' }
  | { t: 'disband' }                                                      // ведущий или создатель: распустить стол, игра заканчивается для всех
  | { t: 'voice' }                                                        // попросить пропуск в голосовую комнату
  | { t: 'voiceJoined' }                                                  // подключился к голосу (или переподключился)
  | { t: 'ping' };                                                        // сердцебиение раз в 25 с, держит связь

export interface MemberInfo {
  id: string;
  nick: string;
  kind: MemberKind;
  connected: boolean;
  bot: boolean;
  seat: number | null;
  photo: string | null; // фото из Telegram (https)
}

export interface RoomInfo {
  code: string;
  you: { id: string; kind: MemberKind; seat: number | null; owner: boolean; mic: boolean }; // mic — можно говорить прямо сейчас
  hostless: boolean;   // комната без ведущего: таймеры идут сами, фолов нет
  voice: boolean;      // на сервере настроен голос
  members: MemberInfo[];
  players: number;     // сколько игроков за столом (нужно 10)
  spectators: number;
}

/** Ответы HTTP API */
export interface ApiUser {
  id: number;
  firstName: string;
  lastName: string | null;
  username: string | null;
  photoUrl: string | null;
}

export interface ApiConfig {
  telegram: { bot: string; app: string | null } | null; // бот для входа и ссылок t.me
  accounts: boolean;                                     // вход и статистика работают (есть бот и база)
}

/** Сервер → браузер */
export type ServerMessage =
  | { t: 'welcome'; code: string; token: string }               // токен хранить в localStorage для resume
  | { t: 'state'; now: number; room: RoomInfo; game: GameView | null } // now — время сервера для таймеров; game === null в лобби
  | { t: 'voice'; url: string; token: string }                  // пропуск в голосовую комнату LiveKit
  | { t: 'error'; message: string; code?: 'room_gone' } // room_gone — вернуться некуда, комнаты больше нет
  | { t: 'closed'; reason: string };

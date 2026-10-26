// Сообщения между браузером и сервером. Всё ходит в JSON по WebSocket.

import type { Action, GameView } from '../engine/index.ts';

export type MemberKind = 'host' | 'player' | 'spectator';

/** Браузер → сервер */
export type ClientMessage =
  | { t: 'create'; nick: string; as?: 'host' | 'player' }                 // создать комнату: вести игру или играть самому (тогда без ведущего)
  | { t: 'join'; code: string; nick: string; as: 'player' | 'spectator' } // войти по коду
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

/** Сервер → браузер */
export type ServerMessage =
  | { t: 'welcome'; code: string; token: string }               // токен хранить в localStorage для resume
  | { t: 'state'; now: number; room: RoomInfo; game: GameView | null } // now — время сервера для таймеров; game === null в лобби
  | { t: 'voice'; url: string; token: string }                  // пропуск в голосовую комнату LiveKit
  | { t: 'error'; message: string; code?: 'room_gone' } // room_gone — вернуться некуда, комнаты больше нет
  | { t: 'closed'; reason: string };

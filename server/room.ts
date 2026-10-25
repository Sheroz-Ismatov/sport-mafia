// Комната: участники, лобби, игра, таймеры, рассылка состояния.
// Ничего не знает о WebSocket: каждому участнику просто дают функцию send().

import { randomUUID } from 'node:crypto';
import { Game, MAX_PLAYERS, MIN_PLAYERS, viewFor } from '../engine/index.ts';
import type { Action, Actor, Settings, Viewer } from '../engine/index.ts';
import { botAction } from './bots.ts';
import type { ClientMessage, MemberInfo, MemberKind, RoomInfo, ServerMessage } from './protocol.ts';

export interface Member {
  id: string;
  token: string;     // секрет для возвращения после обрыва связи
  nick: string;
  kind: MemberKind;
  bot: boolean;
  send: ((msg: ServerMessage) => void) | null; // null — сейчас не на связи
}

export interface RoomOptions {
  settings?: Partial<Settings>;
  now?: () => number;
  rng?: () => number;
  botDelayMs?: [number, number];
  maxSpectators?: number;
  onGameEnd?: (room: Room) => void;
}

const MAX_NICK = 24;

export function cleanNick(raw: unknown): string {
  const nick = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, MAX_NICK) : '';
  if (!nick) throw new Error('Введите ник');
  return nick;
}

export class Room {
  readonly code: string;
  readonly members = new Map<string, Member>(); // ключ — token
  game: Game | null = null;
  emptySince: number | null = null;
  ownerToken: string | null = null; // кто создал комнату: начинает игру, добавляет ботов, запускает новую партию

  private readonly opts: Required<Omit<RoomOptions, 'settings' | 'onGameEnd'>> & Pick<RoomOptions, 'settings' | 'onGameEnd'>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private botTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private endReported = false;

  constructor(code: string, opts: RoomOptions = {}) {
    this.code = code;
    this.opts = {
      now: opts.now ?? Date.now,
      rng: opts.rng ?? Math.random,
      botDelayMs: opts.botDelayMs ?? [600, 1800],
      maxSpectators: opts.maxSpectators ?? 200,
      settings: opts.settings,
      onGameEnd: opts.onGameEnd,
    };
  }

  // ---------- Участники ----------

  addMember(rawNick: unknown, kind: MemberKind, bot = false): Member {
    let nick = cleanNick(rawNick);
    const taken = new Set([...this.members.values()].map((m) => m.nick.toLowerCase()));
    for (let i = 2; taken.has(nick.toLowerCase()); i++) nick = `${cleanNick(rawNick).slice(0, MAX_NICK - 3)} ${i}`;

    // Стол заполнен или игра уже идёт — входим наблюдателем
    if (kind === 'player' && (this.game || this.players().length >= MAX_PLAYERS)) kind = 'spectator';
    if (kind === 'spectator' && this.spectators().length >= this.opts.maxSpectators) {
      throw new Error('В комнате нет мест для зрителей');
    }
    const member: Member = { id: randomUUID().slice(0, 8), token: randomUUID(), nick, kind, bot, send: null };
    this.members.set(member.token, member);
    return member;
  }

  host(): Member | undefined {
    return [...this.members.values()].find((m) => m.kind === 'host');
  }

  isOwner(m: Member): boolean {
    return m.token === this.ownerToken;
  }

  players(): Member[] {
    return [...this.members.values()].filter((m) => m.kind === 'player');
  }

  spectators(): Member[] {
    return [...this.members.values()].filter((m) => m.kind === 'spectator');
  }

  seatOf(m: Member): number | null {
    return this.game?.seats.find((s) => s.playerId === m.id)?.seat ?? null;
  }

  connect(m: Member, send: (msg: ServerMessage) => void): void {
    m.send = send;
    this.emptySince = null;
    send({ t: 'welcome', code: this.code, token: m.token });
    this.broadcast();
  }

  disconnect(m: Member): void {
    m.send = null;
    if (![...this.members.values()].some((x) => x.send && !x.bot)) this.emptySince = this.opts.now();
    this.broadcast();
  }

  /** Выйти из комнаты насовсем. Во время игры место остаётся за игроком. */
  leave(m: Member): void {
    m.send = null;
    if (!this.game && m.kind !== 'host' && !this.isOwner(m)) this.members.delete(m.token);
    this.broadcast();
  }

  // ---------- Сообщения от участника ----------

  /** Возвращает текст ошибки или null. */
  handle(m: Member, msg: ClientMessage): string | null {
    try {
      switch (msg.t) {
        case 'addBots': return this.addBots(m);
        case 'start': return this.start(m);
        case 'restart': return this.restart(m);
        case 'act': return this.act(m, msg.action);
        case 'leave':
          this.leave(m);
          return null;
        default: return 'Неизвестная команда';
      }
    } catch (e) {
      return e instanceof Error ? e.message : 'Ошибка';
    }
  }

  private addBots(m: Member): string | null {
    if (!this.isOwner(m)) return 'Ботов добавляет создатель комнаты';
    if (this.game) return 'Игра уже идёт';
    const names = ['Бот Аня', 'Бот Борис', 'Бот Вика', 'Бот Гоша', 'Бот Даша', 'Бот Егор', 'Бот Женя', 'Бот Зоя', 'Бот Илья', 'Бот Катя'];
    for (let i = 0; this.players().length < MAX_PLAYERS; i++) this.addMember(names[i % names.length], 'player', true);
    this.broadcast();
    return null;
  }

  private start(m: Member): string | null {
    if (!this.isOwner(m)) return 'Начать игру может только создатель комнаты';
    if (this.game) return 'Игра уже идёт';
    const players = this.players();
    if (players.length < MIN_PLAYERS) return `За столом ${players.length}, нужно хотя бы ${MIN_PLAYERS}`;
    const game = new Game(this.opts.settings, this.opts.rng);
    const r = game.dispatch({ kind: 'host' }, {
      type: 'start',
      players: players.map((p) => ({ playerId: p.id, nick: p.nick })),
    }, this.opts.now());
    if (!r.ok) return r.error;
    this.game = game;
    this.afterChange();
    return null;
  }

  /** Новая партия тем же составом: места и роли разыграются заново. */
  private restart(m: Member): string | null {
    if (!this.isOwner(m)) return 'Новую партию начинает создатель комнаты';
    if (!this.game) return 'Игра ещё не начиналась';
    if (this.game.phase !== 'ended') return 'Сначала доиграйте партию';
    this.stopTimers();
    this.game = null;
    this.endReported = false;
    this.broadcast();
    return null;
  }

  private stopTimers(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const t of this.botTimers.values()) clearTimeout(t);
    this.botTimers.clear();
  }

  private act(m: Member, action: Action): string | null {
    const game = this.game;
    if (!game) return 'Игра ещё не началась';
    if (!action || typeof action !== 'object' || typeof action.type !== 'string') return 'Неверное действие';
    if (action.type === 'start' || action.type === 'timeout') return 'Это действие недоступно';

    let actor: Actor;
    if (m.kind === 'host') actor = { kind: 'host' };
    else if (m.kind === 'player') {
      const seat = this.seatOf(m);
      if (seat === null) return 'Вы не за столом';
      actor = { kind: 'seat', seat };
    } else return 'Наблюдатели не участвуют в игре';

    const r = game.dispatch(actor, action, this.opts.now());
    if (!r.ok) return r.error;
    this.afterChange();
    return null;
  }

  // ---------- Таймеры ----------

  private afterChange(): void {
    this.schedule();
    this.scheduleBots();
    this.broadcast();
    if (this.game?.phase === 'ended' && !this.endReported) {
      this.endReported = true;
      this.opts.onGameEnd?.(this);
    }
  }

  /** Ставит серверный таймер на конец текущего шага. */
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const endsAt = this.game?.timer?.endsAt;
    if (endsAt == null || this.game!.phase === 'ended') return;
    const delay = Math.max(0, endsAt - this.opts.now());
    this.timer = setTimeout(() => this.safely(() => {
      this.timer = null;
      const game = this.game;
      if (!game || game.timer?.endsAt !== endsAt) return; // таймер успели поменять
      const r = game.dispatch({ kind: 'system' }, { type: 'timeout' }, this.opts.now());
      if (r.ok) this.afterChange();
    }), delay);
  }

  /** Ошибка в одной комнате не должна ронять весь сервер: пишем в лог и продолжаем. */
  private safely(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      console.error(`Комната ${this.code}: ошибка в таймере`, e);
    }
  }

  private scheduleBots(): void {
    const game = this.game;
    if (!game || game.phase === 'ended') return;
    for (const m of this.members.values()) {
      if (!m.bot || this.botTimers.has(m.token)) continue;
      const seat = this.seatOf(m);
      if (seat === null || !botAction(game, seat, this.opts.rng)) continue;
      const [lo, hi] = this.opts.botDelayMs;
      const delay = lo + this.opts.rng() * (hi - lo);
      this.botTimers.set(m.token, setTimeout(() => this.safely(() => {
        this.botTimers.delete(m.token);
        const g = this.game;
        if (!g) return;
        // Решение принимается заново: за время паузы ситуация могла поменяться
        const action = botAction(g, seat, this.opts.rng);
        if (action && g.dispatch({ kind: 'seat', seat }, action, this.opts.now()).ok) this.afterChange();
        else this.scheduleBots();
      }), delay));
    }
  }

  // ---------- Рассылка ----------

  viewerOf(m: Member): Viewer {
    if (m.kind === 'host') return { kind: 'host' };
    const seat = this.seatOf(m);
    if (m.kind === 'player' && seat !== null) return { kind: 'player', seat };
    return { kind: 'spectator' };
  }

  info(m: Member): RoomInfo {
    const members: MemberInfo[] = [...this.members.values()].map((x) => ({
      id: x.id, nick: x.nick, kind: x.kind, connected: x.bot || x.send !== null, bot: x.bot, seat: this.seatOf(x),
    }));
    return {
      code: this.code,
      you: { id: m.id, kind: m.kind, seat: this.seatOf(m), owner: this.isOwner(m) },
      hostless: !this.host(),
      members,
      players: this.players().length,
      spectators: this.spectators().length,
    };
  }

  broadcast(): void {
    for (const m of this.members.values()) {
      if (!m.send) continue;
      m.send({
        t: 'state',
        now: this.opts.now(),
        room: this.info(m),
        game: this.game ? viewFor(this.game, this.viewerOf(m)) : null,
      });
    }
  }

  close(reason: string): void {
    this.stopTimers();
    for (const m of this.members.values()) m.send?.({ t: 'closed', reason });
  }
}

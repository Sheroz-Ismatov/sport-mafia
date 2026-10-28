// Хранилище бота: кто запускал бота, настройки чатов, сборы и отметки.
// В Postgres (та же база, что статистика), без базы в памяти: тогда сборы теряются при перезапуске.

export interface BotUser {
  tgId: number;
  name: string;
  started: boolean;             // запускал бота: ему можно писать в личку
  experience: string | null;    // newbie | played | knows
}

export interface BotChat {
  chatId: number;
  kind: 'private' | 'group';
  title: string;
  quotes: boolean;              // присылать «фразу Дона» раз в день
  tz: string;                   // пояс чата: время сборов и фразы дня
  lastQuoteDay: string | null;  // в какой день фраза уже была
  quoteSeq: number;             // сколько фраз уже прислали (чтобы не повторяться)
}

export type MemberStatus = 'go' | 'maybe' | 'no';

export interface GatheringMember {
  tgId: number;
  name: string;
  status: MemberStatus;
}

export interface Gathering {
  id: number;
  chatId: number | null;        // где создан сбор
  creatorTgId: number;
  creatorName: string;
  startsAt: Date;
  tz: string;
  status: 'open' | 'cancelled' | 'done';
  reminded60: boolean;
  reminded10: boolean;
  roomCode: string | null;      // стол, открытый для этого сбора
}

export interface BotStore {
  getUser(tgId: number): Promise<BotUser | null>;
  saveUser(u: BotUser): Promise<void>;
  getChat(chatId: number): Promise<BotChat | null>;
  saveChat(c: BotChat): Promise<void>;
  quoteChats(): Promise<BotChat[]>;
  createGathering(g: Omit<Gathering, 'id'>): Promise<Gathering>;
  getGathering(id: number): Promise<Gathering | null>;
  saveGathering(g: Gathering): Promise<void>;
  openGatherings(): Promise<Gathering[]>;
  members(id: number): Promise<GatheringMember[]>;
  setMember(id: number, m: GatheringMember): Promise<void>;
  posts(id: number): Promise<string[]>;     // где висит карточка: «чат:сообщение» или «i:inline_message_id»
  addPost(id: number, ref: string): Promise<void>;
}

export class MemoryBotStore implements BotStore {
  users = new Map<number, BotUser>();
  chats = new Map<number, BotChat>();
  gatherings = new Map<number, Gathering>();
  private mem = new Map<number, GatheringMember[]>();
  private refs = new Map<number, string[]>();
  private seq = 0;

  async getUser(tgId: number) { const u = this.users.get(tgId); return u ? { ...u } : null; }
  async saveUser(u: BotUser) { this.users.set(u.tgId, { ...u }); }
  async getChat(chatId: number) { const c = this.chats.get(chatId); return c ? { ...c } : null; }
  async saveChat(c: BotChat) { this.chats.set(c.chatId, { ...c }); }
  async quoteChats() { return [...this.chats.values()].filter((c) => c.quotes).map((c) => ({ ...c })); }
  async createGathering(g: Omit<Gathering, 'id'>) {
    const full = { ...g, id: ++this.seq };
    this.gatherings.set(full.id, full);
    return { ...full };
  }
  async getGathering(id: number) { const g = this.gatherings.get(id); return g ? { ...g } : null; }
  async saveGathering(g: Gathering) { this.gatherings.set(g.id, { ...g }); }
  async openGatherings() { return [...this.gatherings.values()].filter((g) => g.status === 'open').map((g) => ({ ...g })); }
  async members(id: number) { return (this.mem.get(id) ?? []).map((m) => ({ ...m })); }
  async setMember(id: number, m: GatheringMember) {
    const list = this.mem.get(id) ?? [];
    const old = list.find((x) => x.tgId === m.tgId);
    // Тот же ответ: остаётся на своём месте в очереди; новый ответ: в конец
    if (old && old.status === m.status) old.name = m.name;
    else this.mem.set(id, [...list.filter((x) => x.tgId !== m.tgId), { ...m }]);
  }
  async posts(id: number) { return [...(this.refs.get(id) ?? [])]; }
  async addPost(id: number, ref: string) {
    const list = this.refs.get(id) ?? [];
    if (!list.includes(ref)) list.push(ref);
    this.refs.set(id, list);
  }
}

// ---------- Postgres ----------

interface Pool { query(text: string, params?: unknown[]): Promise<{ rows: any[] }> }

export const BOT_SCHEMA = `
create table if not exists bot_users (
  tg_id bigint primary key,
  name text not null,
  started boolean not null default false,
  experience text,
  updated_at timestamptz not null default now()
);
create table if not exists bot_chats (
  chat_id bigint primary key,
  kind text not null,
  title text not null default '',
  quotes boolean not null default false,
  tz text not null,
  last_quote_day text,
  quote_seq int not null default 0
);
create table if not exists gatherings (
  id bigserial primary key,
  chat_id bigint,
  creator_tg_id bigint not null,
  creator_name text not null,
  starts_at timestamptz not null,
  tz text not null,
  status text not null default 'open',
  reminded60 boolean not null default false,
  reminded10 boolean not null default false,
  room_code text,
  created_at timestamptz not null default now()
);
create index if not exists gatherings_open on gatherings(status) where status = 'open';
create table if not exists gathering_members (
  gathering_id bigint not null references gatherings(id) on delete cascade,
  tg_id bigint not null,
  name text not null,
  status text not null,
  updated_at timestamptz not null default now(),
  primary key (gathering_id, tg_id)
);
create table if not exists gathering_posts (
  gathering_id bigint not null references gatherings(id) on delete cascade,
  ref text not null,
  primary key (gathering_id, ref)
);
`;

const toGathering = (r: any): Gathering => ({
  id: Number(r.id), chatId: r.chat_id === null ? null : Number(r.chat_id), creatorTgId: Number(r.creator_tg_id), creatorName: r.creator_name,
  startsAt: new Date(r.starts_at), tz: r.tz, status: r.status, reminded60: r.reminded60, reminded10: r.reminded10, roomCode: r.room_code,
});
const toChat = (r: any): BotChat => ({
  chatId: Number(r.chat_id), kind: r.kind, title: r.title, quotes: r.quotes, tz: r.tz, lastQuoteDay: r.last_quote_day, quoteSeq: r.quote_seq,
});

export class PgBotStore implements BotStore {
  private readonly pool: Pool;
  constructor(pool: Pool) {
    this.pool = pool;
  }

  static async create(pool: Pool): Promise<PgBotStore> {
    await pool.query(BOT_SCHEMA);
    return new PgBotStore(pool);
  }

  async getUser(tgId: number) {
    const { rows } = await this.pool.query('select * from bot_users where tg_id = $1', [tgId]);
    const r = rows[0];
    return r ? { tgId: Number(r.tg_id), name: r.name, started: r.started, experience: r.experience } : null;
  }
  async saveUser(u: BotUser) {
    await this.pool.query(
      `insert into bot_users (tg_id, name, started, experience) values ($1, $2, $3, $4)
       on conflict (tg_id) do update set name = excluded.name, started = excluded.started, experience = excluded.experience, updated_at = now()`,
      [u.tgId, u.name, u.started, u.experience]);
  }
  async getChat(chatId: number) {
    const { rows } = await this.pool.query('select * from bot_chats where chat_id = $1', [chatId]);
    return rows[0] ? toChat(rows[0]) : null;
  }
  async saveChat(c: BotChat) {
    await this.pool.query(
      `insert into bot_chats (chat_id, kind, title, quotes, tz, last_quote_day, quote_seq) values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (chat_id) do update set kind = excluded.kind, title = excluded.title, quotes = excluded.quotes, tz = excluded.tz,
         last_quote_day = excluded.last_quote_day, quote_seq = excluded.quote_seq`,
      [c.chatId, c.kind, c.title, c.quotes, c.tz, c.lastQuoteDay, c.quoteSeq]);
  }
  async quoteChats() {
    const { rows } = await this.pool.query('select * from bot_chats where quotes');
    return rows.map(toChat);
  }
  async createGathering(g: Omit<Gathering, 'id'>) {
    const { rows } = await this.pool.query(
      `insert into gatherings (chat_id, creator_tg_id, creator_name, starts_at, tz, status, reminded60, reminded10, room_code)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *`,
      [g.chatId, g.creatorTgId, g.creatorName, g.startsAt, g.tz, g.status, g.reminded60, g.reminded10, g.roomCode]);
    return toGathering(rows[0]);
  }
  async getGathering(id: number) {
    const { rows } = await this.pool.query('select * from gatherings where id = $1', [id]);
    return rows[0] ? toGathering(rows[0]) : null;
  }
  async saveGathering(g: Gathering) {
    await this.pool.query(
      `update gatherings set starts_at = $2, tz = $3, status = $4, reminded60 = $5, reminded10 = $6, room_code = $7 where id = $1`,
      [g.id, g.startsAt, g.tz, g.status, g.reminded60, g.reminded10, g.roomCode]);
  }
  async openGatherings() {
    const { rows } = await this.pool.query(`select * from gatherings where status = 'open' order by starts_at`);
    return rows.map(toGathering);
  }
  async members(id: number) {
    const { rows } = await this.pool.query('select * from gathering_members where gathering_id = $1 order by updated_at', [id]);
    return rows.map((r) => ({ tgId: Number(r.tg_id), name: r.name, status: r.status as MemberStatus }));
  }
  async setMember(id: number, m: GatheringMember) {
    // Сменил ответ: встаёт в конец списка (кто раньше сказал «буду», тот в основном составе)
    await this.pool.query(
      `insert into gathering_members (gathering_id, tg_id, name, status) values ($1, $2, $3, $4)
       on conflict (gathering_id, tg_id) do update set name = excluded.name, status = excluded.status,
         updated_at = case when gathering_members.status = excluded.status then gathering_members.updated_at else now() end`,
      [id, m.tgId, m.name, m.status]);
  }
  async posts(id: number) {
    const { rows } = await this.pool.query('select ref from gathering_posts where gathering_id = $1', [id]);
    return rows.map((r) => r.ref as string);
  }
  async addPost(id: number, ref: string) {
    await this.pool.query('insert into gathering_posts (gathering_id, ref) values ($1, $2) on conflict do nothing', [id, ref]);
  }
}

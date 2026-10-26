// Постоянное хранилище: игроки (аккаунты Telegram) и итоги партий. Postgres, например бесплатный Neon.
// Адрес базы в переменной DATABASE_URL. Без неё игра работает, но статистика не сохраняется.

import type { TgUser } from './auth.ts';

export interface User {
  id: number;
  tgId: number;
  firstName: string;
  lastName: string | null;
  username: string | null;
  photoUrl: string | null;
}

export interface GameRecord {
  room: string;
  startedAt: Date | null;
  winner: string;            // red | black | draw
  reason: string;
  hostUserId: number | null; // ведущий с аккаунтом (null — без ведущего или гость)
  bots: number;              // сколько ботов за столом: такие партии не идут в статистику
  log: unknown;
  players: {
    seat: number;
    userId: number | null;   // null — гость или бот
    nick: string;
    bot: boolean;
    role: string;
    won: boolean;
    fouls: number;
    out: string | null;      // voted | killed | removed
  }[];
}

export interface RoleStats { games: number; wins: number }

export interface Stats {
  games: number;              // партии без ботов
  wins: number;
  draws: number;
  roles: Record<'civilian' | 'sheriff' | 'mafia' | 'don', RoleStats>;
  fouls: number;
  removed: number;            // сколько раз удалён за фолы
  hosted: number;             // сколько партий провёл ведущим
  withBots: number;           // партии с ботами (в статистику не входят)
  recent: { endedAt: string; role: string; won: boolean; winner: string; players: number; bots: number; seat: number }[];
}

export interface Db {
  upsertUser(u: TgUser): Promise<User>;
  getUser(id: number): Promise<User | null>;
  saveGame(g: GameRecord): Promise<number>;
  stats(userId: number): Promise<Stats>;
  close(): Promise<void>;
}

// Только то, чем пользуемся из пакета pg
interface PgPool {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
  connect(): Promise<{ query: PgPool['query']; release(): void }>;
  end(): Promise<void>;
  on(event: 'error', fn: (e: Error) => void): void;
}

const SCHEMA = `
create table if not exists users (
  id bigserial primary key,
  tg_id bigint not null unique,
  first_name text not null,
  last_name text,
  username text,
  photo_url text,
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now()
);
create table if not exists games (
  id bigserial primary key,
  room text not null,
  started_at timestamptz,
  ended_at timestamptz not null default now(),
  players int not null,
  bots int not null default 0,
  winner text not null,
  reason text not null default '',
  host_user_id bigint references users(id),
  log jsonb
);
create table if not exists game_players (
  game_id bigint not null references games(id) on delete cascade,
  seat int not null,
  user_id bigint references users(id),
  nick text not null,
  bot boolean not null default false,
  role text not null,
  won boolean not null,
  fouls int not null default 0,
  out_reason text,
  primary key (game_id, seat)
);
create index if not exists game_players_user on game_players(user_id);
create index if not exists games_host on games(host_user_id);
`;

function rowToUser(r: any): User {
  return {
    id: Number(r.id),
    tgId: Number(r.tg_id),
    firstName: r.first_name,
    lastName: r.last_name,
    username: r.username,
    photoUrl: r.photo_url,
  };
}

export class PgDb implements Db {
  private readonly pool: PgPool;

  private constructor(pool: PgPool) {
    this.pool = pool;
  }

  static async connect(url: string): Promise<PgDb> {
    const pg = (await import('pg')).default as unknown as { Pool: new (opts: object) => PgPool };
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
    const pool = new pg.Pool({
      connectionString: url,
      max: 5,
      idleTimeoutMillis: 30_000,
      // Облачные базы (Neon) требуют шифрование
      ssl: local ? undefined : { rejectUnauthorized: true },
    });
    // Обрыв простаивающего соединения (база уснула) не должен ронять сервер
    pool.on('error', (e) => console.error('База: соединение оборвалось', e.message));
    await pool.query(SCHEMA);
    return new PgDb(pool);
  }

  async upsertUser(u: TgUser): Promise<User> {
    const { rows } = await this.pool.query(
      `insert into users (tg_id, first_name, last_name, username, photo_url) values ($1, $2, $3, $4, $5)
       on conflict (tg_id) do update set first_name = excluded.first_name, last_name = excluded.last_name,
         username = excluded.username, photo_url = coalesce(excluded.photo_url, users.photo_url), last_seen = now()
       returning *`,
      [u.tgId, u.firstName, u.lastName, u.username, u.photoUrl],
    );
    return rowToUser(rows[0]);
  }

  async getUser(id: number): Promise<User | null> {
    const { rows } = await this.pool.query('select * from users where id = $1', [id]);
    return rows[0] ? rowToUser(rows[0]) : null;
  }

  async saveGame(g: GameRecord): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const { rows } = await client.query(
        `insert into games (room, started_at, players, bots, winner, reason, host_user_id, log)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [g.room, g.startedAt, g.players.length, g.bots, g.winner, g.reason, g.hostUserId, JSON.stringify(g.log)],
      );
      const id = Number(rows[0].id);
      for (const p of g.players) {
        await client.query(
          `insert into game_players (game_id, seat, user_id, nick, bot, role, won, fouls, out_reason)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [id, p.seat, p.userId, p.nick, p.bot, p.role, p.won, p.fouls, p.out],
        );
      }
      await client.query('commit');
      return id;
    } catch (e) {
      await client.query('rollback').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async stats(userId: number): Promise<Stats> {
    // count() в Postgres приходит строкой (bigint), поэтому везде ::int
    const [byRole, totals, hosted, recent] = await Promise.all([
      this.pool.query(
        `select gp.role, count(*)::int as games, count(*) filter (where gp.won)::int as wins
         from game_players gp join games g on g.id = gp.game_id
         where gp.user_id = $1 and g.bots = 0 group by gp.role`, [userId]),
      this.pool.query(
        `select count(*) filter (where g.bots = 0)::int as games,
                count(*) filter (where g.bots = 0 and gp.won)::int as wins,
                count(*) filter (where g.bots = 0 and g.winner = 'draw')::int as draws,
                coalesce(sum(gp.fouls) filter (where g.bots = 0), 0)::int as fouls,
                count(*) filter (where g.bots = 0 and gp.out_reason = 'removed')::int as removed,
                count(*) filter (where g.bots > 0)::int as with_bots
         from game_players gp join games g on g.id = gp.game_id where gp.user_id = $1`, [userId]),
      this.pool.query('select count(*)::int as n from games where host_user_id = $1', [userId]),
      this.pool.query(
        `select g.ended_at, gp.role, gp.won, g.winner, g.players, g.bots, gp.seat
         from game_players gp join games g on g.id = gp.game_id
         where gp.user_id = $1 order by g.ended_at desc limit 10`, [userId]),
    ]);
    const roles: Stats['roles'] = {
      civilian: { games: 0, wins: 0 }, sheriff: { games: 0, wins: 0 }, mafia: { games: 0, wins: 0 }, don: { games: 0, wins: 0 },
    };
    for (const r of byRole.rows) if (r.role in roles) roles[r.role as keyof Stats['roles']] = { games: r.games, wins: r.wins };
    const t = totals.rows[0];
    return {
      games: t.games, wins: t.wins, draws: t.draws, fouls: t.fouls, removed: t.removed, withBots: t.with_bots,
      roles,
      hosted: hosted.rows[0].n,
      recent: recent.rows.map((r) => ({
        endedAt: new Date(r.ended_at).toISOString(), role: r.role, won: r.won, winner: r.winner, players: r.players, bots: r.bots, seat: r.seat,
      })),
    };
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}

// Точка входа: HTTP + WebSocket сервер и список комнат.
// Запуск: npm start (порт из PORT, по умолчанию 8080)

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS, teamOf } from '../engine/index.ts';
import { Room } from './room.ts';
import type { Member, RoomOptions } from './room.ts';
import { Voice, voiceConfigFromEnv } from './voice.ts';
import { readSession, signSession, telegramConfigFromEnv, verifyInitData, verifyLoginWidget } from './auth.ts';
import type { TelegramConfig } from './auth.ts';
import { PgDb } from './db.ts';
import type { Db, User } from './db.ts';
import type { ApiConfig, ApiUser } from './protocol.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ClientMessage, ServerMessage } from './protocol.ts';

const dist = (name: string) => new URL(`../client/dist/${name}`, import.meta.url);
const STATIC_FILES: Record<string, { file: URL; type: string }> = {
  '/index.html': { file: dist('index.html'), type: 'text/html; charset=utf-8' },
  '/app.js': { file: dist('app.js'), type: 'text/javascript; charset=utf-8' },
  '/styles.css': { file: dist('styles.css'), type: 'text/css; charset=utf-8' },
};

export interface ServerOptions extends RoomOptions {
  port?: number;
  roomIdleMs?: number;     // через сколько закрывать комнату, где не осталось живых людей (по умолчанию минута)
  gamesFile?: string | null; // куда дописывать итоги партий (null — не писать)
  telegram?: TelegramConfig | null; // вход через Telegram
  db?: Db | null;                   // база игроков и партий
}

const apiUser = (u: User): ApiUser => ({ id: u.id, firstName: u.firstName, lastName: u.lastName, username: u.username, photoUrl: u.photoUrl });

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage, limit = 16 * 1024): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Слишком большой запрос'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}'));
      } catch {
        reject(new Error('Неверный JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function startServer(opts: ServerOptions = {}): Promise<{ server: Server; rooms: Map<string, Room>; close: () => Promise<void> }> {
  const rooms = new Map<string, Room>();
  const roomIdleMs = opts.roomIdleMs ?? 60_000;
  const gamesFile = opts.gamesFile === undefined ? 'data/games.jsonl' : opts.gamesFile;

  const telegram = opts.telegram ?? null;
  const db = opts.db ?? null;
  const userOf = (session: unknown): number | null => (telegram && db ? readSession(session, telegram.botToken) : null);

  const saveGame = async (room: Room) => {
    const g = room.game;
    if (!g) return;
    if (db) {
      const byId = new Map([...room.members.values()].map((m) => [m.id, m]));
      await db.saveGame({
        room: room.code,
        startedAt: room.gameStartedAt,
        winner: g.winner ?? 'draw',
        reason: g.endReason,
        hostUserId: room.host()?.userId ?? null,
        bots: g.seats.filter((s) => byId.get(s.playerId)?.bot).length,
        log: g.log.map(({ day, night, text }) => ({ day, night, text })),
        players: g.seats.map((s) => {
          const m = byId.get(s.playerId);
          return {
            seat: s.seat, userId: m?.userId ?? null, nick: s.nick, bot: !!m?.bot, role: s.role!,
            won: g.winner !== 'draw' && teamOf(s.role) === g.winner, fouls: s.fouls, out: s.out?.reason ?? null,
          };
        }),
      });
    }
    if (!gamesFile) return;
    const record = {
      room: room.code,
      endedAt: new Date().toISOString(),
      winner: g.winner,
      reason: g.endReason,
      players: g.seats.map((s) => ({
        seat: s.seat, playerId: s.playerId, nick: s.nick, role: s.role,
        won: g.winner !== 'draw' && teamOf(s.role) === g.winner, fouls: s.fouls, out: s.out,
      })),
      bestMove: g.bestMove,
      log: g.log.map(({ day, night, text }) => ({ day, night, text })),
    };
    await mkdir(gamesFile.replace(/\/[^/]*$/, '') || '.', { recursive: true });
    await appendFile(gamesFile, JSON.stringify(record) + '\n');
  };

  // ---------- HTTP API: вход и профиль ----------
  const api = async (req: IncomingMessage, res: ServerResponse, path: string) => {
    if (path === '/api/config' && req.method === 'GET') {
      const body: ApiConfig = {
        telegram: telegram ? { bot: telegram.botUsername, app: telegram.appName } : null,
        accounts: !!(telegram && db),
      };
      return sendJson(res, 200, body);
    }
    if (!telegram || !db) return sendJson(res, 503, { error: 'Аккаунты на сервере не настроены' });

    if (path === '/api/auth' && req.method === 'POST') {
      const body = await readJson(req);
      let startParam: string | null = null;
      let tg;
      if (typeof body.initData === 'string') {
        const r = verifyInitData(body.initData, telegram.botToken);
        tg = r.user;
        startParam = r.startParam;
      } else if (body.widget && typeof body.widget === 'object') {
        tg = verifyLoginWidget(body.widget, telegram.botToken);
      } else return sendJson(res, 400, { error: 'Нет данных Telegram' });
      const user = await db.upsertUser(tg);
      return sendJson(res, 200, { session: signSession(user.id, telegram.botToken), user: apiUser(user), startParam });
    }

    if (path === '/api/me' && req.method === 'GET') {
      const userId = readSession((req.headers.authorization ?? '').replace(/^Bearer /, ''), telegram.botToken);
      const user = userId === null ? null : await db.getUser(userId);
      if (!user) return sendJson(res, 401, { error: 'Войдите заново' });
      return sendJson(res, 200, { user: apiUser(user), stats: await db.stats(user.id) });
    }
    sendJson(res, 404, { error: 'Не найдено' });
  };

  const newCode = (): string => {
    for (;;) {
      const code = 'MAF-' + String(Math.floor(1000 + Math.random() * 9000));
      if (!rooms.has(code)) return code;
    }
  };

  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
      return;
    }
    if (path.startsWith('/api/')) {
      try {
        await api(req, res, path);
      } catch (e) {
        sendJson(res, 400, { error: e instanceof Error ? e.message : 'Ошибка' });
      }
      return;
    }
    // Страница игры: только файлы из списка, никаких путей с диска от пользователя
    // Голос: собранные куски LiveKit и Krisp из client/dist/lk/ (только простые имена файлов)
    const lk = /^\/lk\/([\w.-]+\.js)$/.exec(path);
    if (lk) {
      try {
        const body = await readFile(dist(`lk/${lk[1]}`));
        // Имена кусков меняются при каждой сборке, кроме lk.js: его не кэшируем
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': lk[1] === 'lk.js' ? 'no-cache' : 'public, max-age=604800, immutable' });
        res.end(body);
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Голос не собран\n');
      }
      return;
    }
    const file = STATIC_FILES[path === '/' ? '/index.html' : path];
    if (file) {
      try {
        const body = await readFile(file.file);
        res.writeHead(200, { 'content-type': file.type, 'cache-control': 'no-cache' });
        res.end(body);
      } catch {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Интерфейс не собран. Выполните npm run build\n');
      }
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Не найдено\n');
  });

  const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });

  // Сердцебиение: кто не ответил на ping за 30 с, тот отключился (например, телефон ушёл в сон)
  const alive = new WeakMap<WebSocket, boolean>();
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (alive.get(client) === false) {
        client.terminate();
        continue;
      }
      alive.set(client, false);
      client.ping();
    }
  }, 30_000);

  wss.on('connection', (ws: WebSocket) => {
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));
    let room: Room | null = null;
    let member: Member | null = null;
    const send = (msg: ServerMessage) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    };
    const error = (message: string) => send({ t: 'error', message });

    ws.on('message', (data) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(data));
        if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') throw new Error();
      } catch {
        return error('Неверное сообщение');
      }
      alive.set(ws, true);
      if (msg.t === 'ping') return;

      try {
        if (msg.t === 'create' || msg.t === 'join' || msg.t === 'resume') {
          if (member) return error('Вы уже в комнате');
          if (msg.t === 'create') {
            room = new Room(newCode(), { ...opts, onGameEnd: (r) => { saveGame(r).catch((e) => console.error('Не удалось сохранить партию', e)); } });
            rooms.set(room.code, room);
            member = room.addMember(msg.nick, msg.as === 'player' ? 'player' : 'host', false, userOf(msg.session));
            room.ownerToken = member.token;
          } else {
            const found = rooms.get(String(msg.code ?? '').trim().toUpperCase());
            if (!found) {
              // Комнаты живут в памяти: после перезапуска сервера их нет
              if (msg.t === 'resume') {
                return send({ t: 'error', code: 'room_gone', message: 'Игра прервалась: сервер перезапускался, и комната закрылась. Создайте новую.' });
              }
              return error('Комната не найдена');
            }
            if (msg.t === 'join') {
              // Тот же аккаунт уже в комнате (например, зашёл с телефона вместо ноутбука): возвращаем на своё место
              const userId = userOf(msg.session);
              member = found.memberOfUser(userId) ?? found.addMember(msg.nick, msg.as === 'spectator' ? 'spectator' : 'player', false, userId);
            } else {
              member = found.members.get(String(msg.token)) ?? null;
              if (!member || member.bot) {
                return send({ t: 'error', code: 'room_gone', message: 'Не удалось вернуться в комнату, войдите заново' });
              }
            }
            room = found;
          }
          return room.connect(member, send);
        }

        if (!room || !member) return error('Сначала войдите в комнату');
        if (msg.t === 'disband') {
          if (!room.canDisband(member)) return error('Распустить стол может только ведущий или создатель комнаты');
          room.close(member.kind === 'host' ? 'Ведущий распустил стол' : `${member.nick} распустил стол`);
          rooms.delete(room.code);
          room = null;
          member = null;
          return;
        }
        const problem = room.handle(member, msg);
        if (problem) error(problem);
        if (msg.t === 'leave') {
          room = null;
          member = null;
        }
      } catch (e) {
        error(e instanceof Error ? e.message : 'Ошибка');
      }
    });

    ws.on('close', () => {
      if (room && member && member.send === send) room.disconnect(member);
    });
  });

  // Уборка: стол, за которым не осталось живых людей (только боты или никого), закрывается через минуту
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
      if (room.closed) rooms.delete(code);
      else if (room.emptySince !== null && now - room.emptySince > roomIdleMs) {
        room.close('Стол закрыт: за ним больше минуты не было живых людей');
        rooms.delete(code);
      }
    }
  }, Math.min(5_000, roomIdleMs));

  return new Promise((resolve) => {
    server.listen(opts.port ?? 8080, () => {
      resolve({
        server,
        rooms,
        close: async () => {
          clearInterval(sweep);
          clearInterval(heartbeat);
          for (const room of rooms.values()) room.close('Сервер остановлен');
          for (const client of wss.clients) client.terminate();
          await new Promise<void>((done) => wss.close(() => server.close(() => done())));
        },
      });
    });
  });
}

// Запуск напрямую: node server/index.ts
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  // Последняя страховка: непредвиденная ошибка попадает в лог, а сервер продолжает работать
  process.on('uncaughtException', (e) => console.error('Непредвиденная ошибка', e));
  process.on('unhandledRejection', (e) => console.error('Необработанный отказ', e));
  const port = Number(process.env.PORT ?? 8080);
  // TIMER_SCALE=0.2 — все таймеры в 5 раз короче, удобно для проверки с ботами
  const scale = Number(process.env.TIMER_SCALE ?? 1);
  const settings = scale > 0 && scale !== 1
    ? Object.fromEntries(Object.entries(DEFAULT_SETTINGS).map(([k, v]) => [k, Math.round(v * scale)]))
    : undefined;
  const voiceCfg = voiceConfigFromEnv();
  const telegram = telegramConfigFromEnv();
  let db: Db | null = null;
  if (process.env.DATABASE_URL) {
    try {
      db = await PgDb.connect(process.env.DATABASE_URL);
      console.log('База данных подключена');
    } catch (e) {
      console.error('Не удалось подключиться к базе, статистика не сохраняется', e);
    }
  }
  console.log(telegram ? `Telegram: @${telegram.botUsername}${telegram.appName ? `/${telegram.appName}` : ''}` : 'Вход через Telegram выключен: не заданы TELEGRAM_BOT_TOKEN и TELEGRAM_BOT_USERNAME');
  startServer({ port, settings, voice: voiceCfg ? new Voice(voiceCfg) : null, telegram, db }).then(() => {
    console.log(`Сервер спортивной мафии: http://localhost:${port}${settings ? ` (таймеры ×${scale})` : ''}`);
    console.log(voiceCfg ? `Голос: ${voiceCfg.url}` : 'Голос выключен: не заданы LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET');
  });
}

// Точка входа: HTTP + WebSocket сервер и список комнат.
// Запуск: npm start (порт из PORT, по умолчанию 8080)

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS, teamOf } from '../engine/index.ts';
import { Room, cleanGender } from './room.ts';
import type { Member, RoomOptions } from './room.ts';
import { Voice, voiceConfigFromEnv } from './voice.ts';
import { readSession, signSession, telegramConfigFromEnv, verifyInitData, verifyLoginWidget } from './auth.ts';
import type { TelegramConfig } from './auth.ts';
import { PgDb } from './db.ts';
import { Bot, webhookSecret } from './bot/bot.ts';
import { HttpTgApi } from './bot/tgapi.ts';
import { MemoryBotStore } from './bot/store.ts';
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
  bot?: Bot | null;                 // бот Дона: webhook, сборы, напоминания
  botTickMs?: number;               // как часто бот проверяет напоминания (по умолчанию 30 с)
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
  const bot = opts.bot ?? null;
  // Бот показывает в карточке приглашения, сколько людей за столом
  if (bot && !bot.opts.roomInfo) {
    bot.opts.roomInfo = (code) => {
      const r = rooms.get(code);
      return r && !r.closed ? { players: r.players().length, host: r.host()?.nick ?? null, started: !!r.game } : null;
    };
  }
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
        telegram: telegram ? { bot: telegram.botUsername, app: telegram.appName, inline: !!opts.bot?.inline } : null,
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
      if (!user) return sendJson(res, 401, { error: 'Войди заново' });
      return sendJson(res, 200, { user: apiUser(user), stats: await db.stats(user.id) });
    }
    sendJson(res, 404, { error: 'Не найдено' });
  };

  // Фото игроков из Telegram для мест за столом (запоминаем, чтобы не ходить в базу на каждый вход)
  const photos = new Map<number, string | null>();
  const photoOf = async (userId: number | null): Promise<string | null> => {
    if (userId === null || !db) return null;
    if (photos.has(userId)) return photos.get(userId)!;
    try {
      const u = await db.getUser(userId);
      const photo = u?.photoUrl && /^https:\/\//.test(u.photoUrl) ? u.photoUrl : null;
      photos.set(userId, photo);
      return photo;
    } catch {
      return null;
    }
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
    // Сообщения от Telegram для бота: адрес и заголовок с секретом знает только Telegram
    if (bot && telegram && req.method === 'POST' && path === `/tg/${webhookSecret(telegram.botToken)}`) {
      if (req.headers['x-telegram-bot-api-secret-token'] !== webhookSecret(telegram.botToken)) {
        res.writeHead(401);
        res.end();
        return;
      }
      let update: unknown;
      try {
        update = await readJson(req, 1024 * 1024);
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }
      // Отвечаем сразу, а обрабатываем потом: иначе Telegram будет повторять сообщение
      res.writeHead(200);
      res.end();
      void bot.handleUpdate(update);
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
    // Рисунки карт (только простые имена файлов)
    const img = /^\/img\/([\w-]+\.(webp|png|jpg))$/.exec(path);
    if (img) {
      try {
        const body = await readFile(dist(`img/${img[1]}`));
        const type = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }[img[2]];
        res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=86400' });
        res.end(body);
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Не найдено\n');
      }
      return;
    }
    // Свои шрифты (только простые имена файлов): не меняются, кэшируем надолго
    const font = /^\/fonts\/([\w-]+\.woff2)$/.exec(path);
    if (font) {
      try {
        const body = await readFile(dist(`fonts/${font[1]}`));
        res.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'public, max-age=31536000, immutable' });
        res.end(body);
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Не найдено\n');
      }
      return;
    }
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

    // Сообщения одного соединения обрабатываем строго по очереди: вход ждёт фото из базы
    let queue: Promise<void> = Promise.resolve();
    ws.on('message', (data) => {
      queue = queue.then(() => onMessage(data)).catch((e) => console.error('Ошибка обработки сообщения', e));
    });

    const onMessage = async (data: unknown): Promise<void> => {
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
          if (member) return error('Ты уже за столом');
          if (msg.t === 'create') {
            room = new Room(newCode(), { ...opts, onGameEnd: (r) => { saveGame(r).catch((e) => console.error('Не удалось сохранить партию', e)); } });
            rooms.set(room.code, room);
            const userId = userOf(msg.session);
            const photo = await photoOf(userId);
            member = room.addMember(msg.nick, msg.as === 'player' ? 'player' : 'host', false, userId, cleanGender(msg.gender));
            member.photoUrl = photo;
            room.ownerToken = member.token;
            // Стол для сбора из бота: бот позовёт всех, кто записался
            const gid = Number(msg.gathering);
            if (bot && db && userId !== null && Number.isInteger(gid) && gid > 0) {
              const code = room.code;
              void db.getUser(userId).then((u) => (u ? bot.roomOpened(gid, code, u.tgId) : false))
                .catch((e) => console.error('Бот: не удалось позвать на стол сбора', e));
            }
          } else {
            const found = rooms.get(String(msg.code ?? '').trim().toUpperCase());
            if (!found) {
              // Комнаты живут в памяти: после перезапуска сервера их нет
              if (msg.t === 'resume') {
                return send({ t: 'error', code: 'room_gone', message: 'Игра прервалась: сервер перезапускался, и стол закрылся. Создай новый.' });
              }
              return error('Комната не найдена');
            }
            if (msg.t === 'join') {
              // Тот же аккаунт уже в комнате (например, зашёл с телефона вместо ноутбука): возвращаем на своё место
              const userId = userOf(msg.session);
              const photo = await photoOf(userId);
              const already = found.memberOfUser(userId);
              member = already ?? found.addMember(msg.nick, msg.as === 'spectator' ? 'spectator' : 'player', false, userId, cleanGender(msg.gender));
              if (!already) member.photoUrl = photo;
            } else {
              member = found.members.get(String(msg.token)) ?? null;
              if (!member || member.bot) {
                return send({ t: 'error', code: 'room_gone', message: 'Не удалось вернуться за стол, войди заново' });
              }
            }
            room = found;
          }
          return room.connect(member, send);
        }

        if (!room || !member) return error('Сначала сядь за стол');
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
    };

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

  // Бот: напоминания о сборах и фраза дня
  const botTimer = bot ? setInterval(() => { bot.tick().catch((e) => console.error('Бот: ошибка таймера', e)); }, opts.botTickMs ?? 30_000) : null;

  return new Promise((resolve) => {
    server.listen(opts.port ?? 8080, () => {
      resolve({
        server,
        rooms,
        close: async () => {
          clearInterval(sweep);
          if (botTimer) clearInterval(botTimer);
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
  // Бот Дона: хранилище в той же базе (без базы в памяти), webhook на публичный адрес сайта
  const publicUrl = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '') || null;
  let bot: Bot | null = null;
  if (telegram) {
    const pg = db instanceof PgDb ? db : null;
    bot = new Bot({
      api: new HttpTgApi(telegram.botToken),
      store: pg ? await pg.botStore() : new MemoryBotStore(),
      botUsername: telegram.botUsername,
      appName: telegram.appName,
      publicUrl,
      defaultTz: process.env.BOT_TZ || 'Asia/Dushanbe',
      stats: pg ? async (tgId) => { const u = await pg.userByTg(tgId); return u ? pg.stats(u.id) : null; } : undefined,
    });
    if (publicUrl) {
      const secret = webhookSecret(telegram.botToken);
      bot.setup(`${publicUrl}/tg/${secret}`, secret)
        .then(() => console.log(`Бот: webhook настроен, inline ${bot!.inline ? 'включён' : 'выключен (BotFather → /setinline)'}`))
        .catch((e) => console.error('Бот: не удалось настроить webhook', e));
      // Бесплатный Render засыпает через 15 минут без запросов. Пока впереди сбор или кто-то ждёт фразу дня,
      // стучимся к себе раз в 10 минут, чтобы напоминания ушли вовремя.
      setInterval(() => {
        bot!.needsAwake().then((need) => (need ? fetch(`${publicUrl}/health`).then(() => {}) : undefined)).catch(() => {});
      }, 10 * 60_000);
    } else console.log('Бот: нет PUBLIC_URL, webhook не настроен (на Render адрес берётся сам)');
  }
  console.log(telegram ? `Telegram: @${telegram.botUsername}${telegram.appName ? `/${telegram.appName}` : ''}` : 'Вход через Telegram выключен: не заданы TELEGRAM_BOT_TOKEN и TELEGRAM_BOT_USERNAME');
  startServer({ port, settings, voice: voiceCfg ? new Voice(voiceCfg) : null, telegram, db, bot }).then(() => {
    console.log(`Сервер спортивной мафии: http://localhost:${port}${settings ? ` (таймеры ×${scale})` : ''}`);
    console.log(voiceCfg ? `Голос: ${voiceCfg.url}` : 'Голос выключен: не заданы LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET');
  });
}

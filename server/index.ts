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
import type { ClientMessage, ServerMessage } from './protocol.ts';

const STATIC_FILES: Record<string, { name: string; type: string }> = {
  '/index.html': { name: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { name: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/styles.css': { name: 'styles.css', type: 'text/css; charset=utf-8' },
};

export interface ServerOptions extends RoomOptions {
  port?: number;
  roomIdleMs?: number;     // через сколько удалять комнату, где никого нет
  gamesFile?: string | null; // куда дописывать итоги партий (null — не писать)
}

export function startServer(opts: ServerOptions = {}): Promise<{ server: Server; rooms: Map<string, Room>; close: () => Promise<void> }> {
  const rooms = new Map<string, Room>();
  const roomIdleMs = opts.roomIdleMs ?? 30 * 60_000;
  const gamesFile = opts.gamesFile === undefined ? 'data/games.jsonl' : opts.gamesFile;

  const saveGame = async (room: Room) => {
    const g = room.game;
    if (!g || !gamesFile) return;
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
    // Страница игры: только файлы из списка, никаких путей с диска от пользователя
    const file = STATIC_FILES[path === '/' ? '/index.html' : path];
    if (file) {
      try {
        const body = await readFile(new URL(`../client/dist/${file.name}`, import.meta.url));
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
            member = room.addMember(msg.nick, msg.as === 'player' ? 'player' : 'host');
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
              member = found.addMember(msg.nick, msg.as === 'spectator' ? 'spectator' : 'player');
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

  // Уборка: комнаты, где давно никого нет
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
      if (room.emptySince !== null && now - room.emptySince > roomIdleMs) {
        room.close('Комната закрыта: в ней долго никого не было');
        rooms.delete(code);
      }
    }
  }, 60_000);

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
  startServer({ port, settings }).then(() => {
    console.log(`Сервер спортивной мафии: http://localhost:${port}${settings ? ` (таймеры ×${scale})` : ''}`);
  });
}

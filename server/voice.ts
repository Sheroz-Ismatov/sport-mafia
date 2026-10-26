// Голос через LiveKit. Сервер решает, кто сейчас может говорить, и сам открывает и закрывает микрофоны:
// даже изменённый браузер не сможет говорить не в свою минуту.
//
// Нужны три переменные окружения (на Render: Environment):
//   LIVEKIT_URL         адрес проекта, например wss://sport-mafia-xxxx.livekit.cloud
//   LIVEKIT_API_KEY     ключ
//   LIVEKIT_API_SECRET  секрет
// Без них игра работает как раньше, только без голоса.

import { createHmac } from 'node:crypto';

export interface VoiceConfig {
  url: string;
  apiKey: string;
  apiSecret: string;
}

export function voiceConfigFromEnv(env: NodeJS.ProcessEnv = process.env): VoiceConfig | null {
  const url = env.LIVEKIT_URL?.trim();
  const apiKey = env.LIVEKIT_API_KEY?.trim();
  const apiSecret = env.LIVEKIT_API_SECRET?.trim();
  return url && apiKey && apiSecret ? { url, apiKey, apiSecret } : null;
}

const b64url = (data: string | Buffer) => Buffer.from(data).toString('base64url');

/** JWT в формате LiveKit (HS256). */
export function signToken(cfg: VoiceConfig, claims: Record<string, unknown>, ttlSec: number, nowSec = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iss: cfg.apiKey, nbf: nowSec - 10, exp: nowSec + ttlSec, ...claims }));
  const sig = createHmac('sha256', cfg.apiSecret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

interface Entry {
  joined: boolean;         // участник подключился к голосу (сообщил браузер)
  want: boolean;           // может ли говорить по правилам прямо сейчас
  applied: boolean | null; // что сейчас стоит в LiveKit (null — неизвестно)
  busy: boolean;
}

export class Voice {
  readonly cfg: VoiceConfig;
  private readonly fetch: FetchFn;
  private readonly entries = new Map<string, Entry>();
  private readonly log: (...args: unknown[]) => void;

  constructor(cfg: VoiceConfig, opts: { fetch?: FetchFn; log?: (...args: unknown[]) => void } = {}) {
    this.cfg = cfg;
    this.fetch = opts.fetch ?? (globalThis.fetch as unknown as FetchFn);
    this.log = opts.log ?? ((...a) => console.error(...a));
  }

  /** Пропуск в голосовую комнату. Микрофон сразу открыт, только если участник может говорить сейчас. */
  join(room: string, identity: string, name: string, canPublish: boolean): { url: string; token: string } {
    const e = this.entry(room, identity);
    e.want = canPublish;
    e.applied = canPublish;
    e.joined = false;
    const token = signToken(this.cfg, {
      sub: identity,
      name,
      video: { room, roomJoin: true, canSubscribe: true, canPublish, canPublishData: false },
    }, 6 * 3600);
    return { url: this.cfg.url, token };
  }

  /** Браузер подключился (или переподключился): сверяем права ещё раз. */
  joined(room: string, identity: string): void {
    const e = this.entry(room, identity);
    e.joined = true;
    e.applied = null;
    this.pump(room, identity, e);
  }

  /** Вызывается при каждом изменении состояния комнаты. Запросы уходят только при изменении. */
  setAllowed(room: string, identity: string, allowed: boolean): void {
    const e = this.entries.get(`${room}/${identity}`);
    if (!e) return; // к голосу не подключался
    e.want = allowed;
    this.pump(room, identity, e);
  }

  dropRoom(room: string): void {
    for (const key of this.entries.keys()) if (key.startsWith(`${room}/`)) this.entries.delete(key);
  }

  /** Есть ли незавершённые запросы (для тестов). */
  idle(): boolean {
    return [...this.entries.values()].every((e) => !e.busy);
  }

  private entry(room: string, identity: string): Entry {
    const key = `${room}/${identity}`;
    let e = this.entries.get(key);
    if (!e) {
      e = { joined: false, want: false, applied: null, busy: false };
      this.entries.set(key, e);
    }
    return e;
  }

  private pump(room: string, identity: string, e: Entry): void {
    if (e.busy || !e.joined || e.want === e.applied) return;
    const value = e.want;
    e.busy = true;
    this.updatePermission(room, identity, value)
      .then((status) => {
        if (status === 'ok') e.applied = value;
        else {
          e.applied = null;
          // Участника нет в голосовой комнате: ждём, пока браузер снова сообщит о подключении
          if (status === 'gone') e.joined = false;
        }
      })
      .catch((err) => {
        e.applied = null;
        this.log('LiveKit: не удалось обновить права', err);
      })
      .finally(() => {
        e.busy = false;
        // Пока ждали ответа, право могло поменяться ещё раз
        if (e.applied !== null) this.pump(room, identity, e);
      });
  }

  private async updatePermission(room: string, identity: string, canPublish: boolean): Promise<'ok' | 'gone' | 'error'> {
    const base = this.cfg.url.replace(/^ws/, 'http').replace(/\/+$/, '');
    const admin = signToken(this.cfg, { video: { room, roomAdmin: true } }, 600);
    const res = await this.fetch(`${base}/twirp/livekit.RoomService/UpdateParticipant`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${admin}` },
      body: JSON.stringify({ room, identity, permission: { canSubscribe: true, canPublish, canPublishData: false } }),
    });
    if (res.ok) return 'ok';
    if (res.status === 404) return 'gone';
    this.log(`LiveKit: ответ ${res.status}`, (await res.text().catch(() => '')).slice(0, 200));
    return 'error';
  }
}

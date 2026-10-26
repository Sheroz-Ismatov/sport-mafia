// Голос в браузере через LiveKit. Библиотека грузится, только когда человек нажал «Включить голос».
// Микрофон открывается сам, когда по правилам слово у вас, и закрывается, когда время вышло.
// Сервер дублирует это со своей стороны, поэтому говорить не в свою минуту нельзя.

import type { RoomInfo } from '../../server/protocol.ts';

// Ровно то, чем пользуемся из livekit-client
interface LkTrack {
  kind: string;
  attach(): HTMLMediaElement;
  detach(): HTMLMediaElement[];
  setProcessor?(processor: unknown): Promise<void>;
}
interface LkPublication { kind?: string; source?: string; track?: LkTrack }
interface KrispProcessor { setEnabled(on: boolean): Promise<unknown> }
interface KrispModule {
  KrispNoiseFilter(opts?: object): KrispProcessor;
  isKrispNoiseFilterSupported(): boolean;
}
interface LkParticipant { identity: string; isSpeaking?: boolean }
interface LkLocalParticipant extends LkParticipant {
  isMicrophoneEnabled: boolean;
  permissions?: { canPublish?: boolean };
  setMicrophoneEnabled(on: boolean): Promise<unknown>;
}
interface LkRoom {
  localParticipant: LkLocalParticipant;
  canPlaybackAudio: boolean;
  on(event: string, fn: (...args: any[]) => void): LkRoom;
  connect(url: string, token: string): Promise<void>;
  disconnect(): Promise<void>;
  startAudio(): Promise<void>;
}
interface LkLib {
  Room: new (opts?: object) => LkRoom;
  loadKrisp: (() => Promise<KrispModule>) | null;
}

export type VoiceStatus = 'off' | 'loading' | 'connecting' | 'on' | 'error';

export interface VoiceState {
  status: VoiceStatus;
  error: string | null;
  micOn: boolean;          // микрофон сейчас реально передаёт звук
  selfMuted: boolean;      // человек сам выключил микрофон
  needsTap: boolean;       // браузер не дал включить звук без нажатия
  talking: Set<string>;    // кто сейчас говорит (id участников)
  noise: 'pending' | 'krisp' | 'browser'; // шумоподавление: Krisp или только встроенное в браузер
}

let lib: Promise<LkLib> | null = null;
const LIB_URL = '/lk/lk.js'; // через переменную, чтобы сборщик не пытался вшить файл в app.js

function loadLib(): Promise<LkLib> {
  lib ??= (import(LIB_URL) as Promise<LkLib>).catch(() => {
    lib = null;
    throw new Error('Не удалось загрузить библиотеку голоса');
  });
  return lib;
}

function micErrorText(e: unknown): string {
  const name = (e as { name?: string })?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Нет доступа к микрофону. Разрешите его в настройках браузера';
  if (name === 'NotFoundError') return 'Микрофон не найден';
  if (name === 'NotReadableError') return 'Микрофон занят другой программой';
  return 'Не получилось включить микрофон';
}

export class VoiceClient {
  readonly state: VoiceState = { status: 'off', error: null, micOn: false, selfMuted: false, needsTap: false, talking: new Set(), noise: 'pending' };
  private krispBroken = false; // Krisp не работает в этом браузере или на тарифе: больше не пробуем
  private room: LkRoom | null = null;
  private allowed = false;      // по правилам можно говорить (из состояния сервера)
  private syncing = false;
  private resync = false;
  private readonly audioBox: HTMLElement;
  private readonly onChange: () => void;
  private readonly send: (msg: { t: 'voice' } | { t: 'voiceJoined' }) => void;

  constructor(send: VoiceClient['send'], onChange: () => void) {
    this.send = send;
    this.onChange = onChange;
    this.audioBox = document.createElement('div');
    this.audioBox.hidden = true;
    document.body.appendChild(this.audioBox);
  }

  /** «Включить голос». Вызывать из нажатия: так браузер разрешит звук. */
  async start(): Promise<void> {
    if (this.state.status === 'loading' || this.state.status === 'connecting' || this.state.status === 'on') return;
    this.set({ status: 'loading', error: null });
    try {
      await loadLib();
      this.set({ status: 'connecting' });
      this.send({ t: 'voice' });
    } catch (e) {
      this.set({ status: 'error', error: (e as Error).message });
    }
  }

  /** Сервер прислал пропуск. */
  async connect(url: string, token: string): Promise<void> {
    if (this.state.status !== 'connecting') return;
    try {
      const Lk = await loadLib();
      await this.room?.disconnect();
      const room = new Lk.Room({
        adaptiveStream: false,
        dynacast: false,
        audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      this.room = room;
      room
        .on('trackSubscribed', (track: LkTrack) => {
          if (track.kind === 'audio') this.audioBox.appendChild(track.attach());
        })
        .on('trackUnsubscribed', (track: LkTrack) => {
          for (const el of track.detach()) el.remove();
        })
        .on('activeSpeakersChanged', (speakers: LkParticipant[]) => {
          this.set({ talking: new Set(speakers.map((p) => p.identity)) });
        })
        .on('audioPlaybackChanged', () => this.set({ needsTap: !room.canPlaybackAudio }))
        .on('participantPermissionsChanged', () => this.sync())
        .on('localTrackPublished', (pub: LkPublication) => {
          void this.sync();
          if (pub?.source === 'microphone' && pub.track) void this.applyKrisp(pub.track);
        })
        .on('localTrackUnpublished', () => this.sync())
        .on('trackMuted', () => this.sync())
        .on('trackUnmuted', () => this.sync())
        .on('reconnected', () => {
          this.send({ t: 'voiceJoined' });
          this.sync();
        })
        .on('disconnected', () => {
          if (this.room !== room) return;
          this.room = null;
          this.audioBox.replaceChildren();
          this.set({ status: 'off', micOn: false, talking: new Set(), error: 'Голос отключился. Нажмите, чтобы включить снова' });
        });
      await room.connect(url, token);
      this.send({ t: 'voiceJoined' });
      await room.startAudio().catch(() => {});
      this.set({ status: 'on', needsTap: !room.canPlaybackAudio });
      await this.sync();
    } catch (e) {
      this.room = null;
      this.set({ status: 'error', error: 'Не удалось подключиться к голосу: ' + ((e as Error).message || 'ошибка сети') });
    }
  }

  /**
   * Шумоподавление Krisp из LiveKit Cloud: убирает шорохи, клавиатуру, фоновые голоса.
   * Каждый новый трек микрофона (после закрытия и открытия) получает свой фильтр.
   * Если Krisp недоступен, остаётся встроенное шумоподавление браузера.
   */
  private async applyKrisp(track: LkTrack): Promise<void> {
    if (this.krispBroken || !track.setProcessor) return this.set({ noise: 'browser' });
    try {
      const Lk = await loadLib();
      const krisp = await Lk.loadKrisp?.();
      if (!krisp || !krisp.isKrispNoiseFilterSupported()) {
        this.krispBroken = true;
        return this.set({ noise: 'browser' });
      }
      const filter = krisp.KrispNoiseFilter();
      await track.setProcessor(filter);
      await filter.setEnabled(true);
      this.set({ noise: 'krisp' });
    } catch (e) {
      console.warn('Krisp не включился, остаётся шумоподавление браузера', e);
      this.krispBroken = true;
      this.set({ noise: 'browser' });
    }
  }

  async stop(): Promise<void> {
    const room = this.room;
    this.room = null;
    this.audioBox.replaceChildren();
    this.set({ status: 'off', micOn: false, talking: new Set(), error: null, needsTap: false });
    await room?.disconnect();
  }

  /** Нажатие, чтобы браузер разрешил воспроизводить звук. */
  async unlockAudio(): Promise<void> {
    await this.room?.startAudio().catch(() => {});
    this.set({ needsTap: this.room ? !this.room.canPlaybackAudio : false });
  }

  toggleMute(): void {
    this.set({ selfMuted: !this.state.selfMuted });
    void this.sync();
  }

  /** Новое состояние комнаты от сервера. */
  update(room: RoomInfo | null): void {
    const allowed = !!room?.you.mic;
    if (!room && this.room) void this.stop();
    if (allowed === this.allowed) return;
    this.allowed = allowed;
    void this.sync();
  }

  get canSpeak(): boolean {
    return this.allowed;
  }

  /** Приводит микрофон к тому, что разрешено. */
  private async sync(): Promise<void> {
    if (this.syncing) {
      this.resync = true;
      return;
    }
    this.syncing = true;
    try {
      do {
        this.resync = false;
        const room = this.room;
        if (!room) break;
        const me = room.localParticipant;
        const want = this.allowed && !this.state.selfMuted && me.permissions?.canPublish !== false;
        if (want !== me.isMicrophoneEnabled) {
          try {
            await me.setMicrophoneEnabled(want);
            if (this.state.error) this.set({ error: null });
          } catch (e) {
            // Права от сервера ещё не дошли: придёт событие participantPermissionsChanged, и попробуем снова
            if (want && me.permissions?.canPublish) this.set({ error: micErrorText(e) });
          }
        }
        this.set({ micOn: room.localParticipant.isMicrophoneEnabled });
      } while (this.resync);
    } finally {
      this.syncing = false;
    }
  }

  private set(patch: Partial<VoiceState>): void {
    let changed = false;
    for (const [k, v] of Object.entries(patch) as [keyof VoiceState, unknown][]) {
      const old: unknown = this.state[k];
      const same = old instanceof Set && v instanceof Set
        ? old.size === v.size && [...old].every((x) => v.has(x))
        : old === v;
      if (!same) {
        (this.state[k] as unknown) = v;
        changed = true;
      }
    }
    if (changed) this.onChange();
  }
}

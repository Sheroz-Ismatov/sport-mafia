// Связь с сервером: WebSocket, автоматическое переподключение и возвращение на своё место.

import type { ClientMessage, ServerMessage } from '../../server/protocol.ts';

export class Net {
  private ws: WebSocket | null = null;
  private retry = 0;
  private pinger: ReturnType<typeof setInterval> | null = null;
  private readonly url: string;
  private readonly onMessage: (msg: ServerMessage) => void;
  private readonly onStatus: (online: boolean) => void;
  private readonly onOpen: () => void;

  constructor(onMessage: (msg: ServerMessage) => void, onStatus: (online: boolean) => void, onOpen: () => void) {
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.onOpen = onOpen;
    this.url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
  }

  connect(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.retry = 0;
      // Сердцебиение: не даёт серверу и прокси закрыть тихое соединение
      if (this.pinger) clearInterval(this.pinger);
      this.pinger = setInterval(() => this.send({ t: 'ping' }), 25_000);
      this.onStatus(true);
      this.onOpen();
    });
    ws.addEventListener('message', (e) => {
      try {
        this.onMessage(JSON.parse(String(e.data)) as ServerMessage);
      } catch {
        // повреждённое сообщение пропускаем
      }
    });
    ws.addEventListener('close', () => {
      if (this.ws !== ws) return;
      if (this.pinger) clearInterval(this.pinger);
      this.onStatus(false);
      // Переподключаемся: 0.5 с, 1 с, 2 с ... не реже раза в 8 с
      const delay = Math.min(8000, 500 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    });
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}

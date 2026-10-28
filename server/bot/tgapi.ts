// Вызовы Bot API Telegram. В тестах подменяется записывающей заглушкой.

export interface TgApi {
  call(method: string, params?: Record<string, unknown>): Promise<any>;
}

/** Ошибка Telegram: code 403 значит, что человек не запускал бота или заблокировал его. */
export class TgError extends Error {
  readonly code: number;
  constructor(code: number, description: string) {
    super(description);
    this.code = code;
  }
}

export class HttpTgApi implements TgApi {
  private readonly base: string;
  constructor(token: string) {
    this.base = `https://api.telegram.org/bot${token}/`;
  }

  async call(method: string, params: Record<string, unknown> = {}): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(this.base + method, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(15_000),
      });
      const body = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` })) as {
        ok: boolean; result?: unknown; description?: string; error_code?: number; parameters?: { retry_after?: number };
      };
      if (body.ok) return body.result;
      // Слишком часто: Telegram просит подождать, повторяем один раз
      const wait = body.parameters?.retry_after;
      if (body.error_code === 429 && wait && attempt === 0) {
        await new Promise((r) => setTimeout(r, Math.min(wait, 10) * 1000));
        continue;
      }
      throw new TgError(body.error_code ?? res.status, body.description ?? 'Ошибка Telegram');
    }
  }
}

/** Экранирование для parse_mode HTML: ники и тексты от людей. */
export function h(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

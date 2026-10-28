// Вызовы Bot API Telegram. В тестах подменяется записывающей заглушкой.

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

export interface TgApi {
  call(method: string, params?: Record<string, unknown>): Promise<any>;
  /** Вызов с загрузкой файлов: files — поле формы → путь к файлу на диске. */
  upload(method: string, params: Record<string, unknown>, files: Record<string, string>): Promise<any>;
}

/** Ошибка Telegram: code 403 значит, что человек не запускал бота или заблокировал его. */
export class TgError extends Error {
  readonly code: number;
  constructor(code: number, description: string) {
    super(description);
    this.code = code;
  }
}

type Reply = { ok: boolean; result?: unknown; description?: string; error_code?: number; parameters?: { retry_after?: number } };

export class HttpTgApi implements TgApi {
  private readonly base: string;
  constructor(token: string) {
    this.base = `https://api.telegram.org/bot${token}/`;
  }

  call(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return this.request(method, () => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) }));
  }

  async upload(method: string, params: Record<string, unknown>, files: Record<string, string>): Promise<any> {
    const blobs = await Promise.all(Object.entries(files).map(async ([field, path]) => [field, path, new Blob([await readFile(path)], { type: 'image/jpeg' })] as const));
    return this.request(method, () => {
      const form = new FormData();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
      }
      for (const [field, path, blob] of blobs) form.append(field, blob, basename(path));
      return { body: form };
    });
  }

  private async request(method: string, init: () => { headers?: Record<string, string>; body: BodyInit }): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(this.base + method, { method: 'POST', ...init(), signal: AbortSignal.timeout(30_000) });
      const body = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` })) as Reply;
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

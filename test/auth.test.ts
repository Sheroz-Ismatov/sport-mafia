import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readSession, signSession, verifyInitData, verifyLoginWidget } from '../server/auth.ts';

const TOKEN = '123456:TEST-bot-token';
const NOW = 1_800_000_000;

/** Подписывает initData так же, как Telegram. */
function makeInitData(fields: Record<string, string>, token = TOKEN): string {
  const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

const user = JSON.stringify({ id: 42, first_name: 'Лео', username: 'leo', photo_url: 'https://t.me/i/userpic/1.jpg' });

test('Mini App: верная подпись принимается, start_param читается', () => {
  const init = makeInitData({ user, auth_date: String(NOW - 100), start_param: 'MAF-1234', query_id: 'q', signature: 'sig' });
  const r = verifyInitData(init, TOKEN, NOW);
  assert.equal(r.user.tgId, 42);
  assert.equal(r.user.firstName, 'Лео');
  assert.equal(r.user.username, 'leo');
  assert.equal(r.startParam, 'MAF-1234');
});

test('Mini App: подделка, чужой бот и старые данные отклоняются', () => {
  const init = makeInitData({ user, auth_date: String(NOW - 100) });
  const forged = init.replace('%D0%9B%D0%B5%D0%BE', '%D0%90%D0%BD%D1%8F'); // Лео → Аня
  assert.notEqual(forged, init);
  assert.throws(() => verifyInitData(forged, TOKEN, NOW), /Подпись/);
  assert.throws(() => verifyInitData(init, '999:other', NOW), /Подпись/);
  assert.throws(() => verifyInitData(makeInitData({ user, auth_date: String(NOW - 2 * 86400) }), TOKEN, NOW), /устарели/);
  assert.throws(() => verifyInitData('', TOKEN, NOW), /Подпись/);
});

test('кнопка входа на сайте: подпись по SHA256 от токена', () => {
  const data: Record<string, string | number> = { id: 7, first_name: 'Аня', username: 'anya', auth_date: NOW - 10 };
  const check = Object.keys(data).sort().map((k) => `${k}=${data[k]}`).join('\n');
  const hash = createHmac('sha256', createHash('sha256').update(TOKEN).digest()).update(check).digest('hex');
  assert.equal(verifyLoginWidget({ ...data, hash }, TOKEN, NOW).tgId, 7);
  assert.throws(() => verifyLoginWidget({ ...data, id: 8, hash }, TOKEN, NOW), /Подпись/);
});

test('сессия: своя подпись и срок', () => {
  const s = signSession(15, TOKEN, NOW);
  assert.equal(readSession(s, TOKEN, NOW + 10), 15);
  assert.equal(readSession(s, '999:other', NOW), null);
  assert.equal(readSession(s.slice(0, -2) + 'xx', TOKEN, NOW), null);
  assert.equal(readSession(s, TOKEN, NOW + 61 * 86400), null);
  assert.equal(readSession(42, TOKEN, NOW), null);
});

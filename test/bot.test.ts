// Бот Дона: знакомство, сборы и напоминания, фраза дня, карточки приглашения, webhook.
// Telegram подменён заглушкой, которая записывает все вызовы.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { Bot, webhookSecret } from '../server/bot/bot.ts';
import { MemoryBotStore } from '../server/bot/store.ts';
import { TgError } from '../server/bot/tgapi.ts';
import type { TgApi } from '../server/bot/tgapi.ts';
import { parseWhen, formatWhen } from '../server/bot/time.ts';
import { JOKES, jokeFor } from '../server/bot/jokes.ts';
import { startServer } from '../server/index.ts';

class FakeApi implements TgApi {
  calls: { method: string; params: any }[] = [];
  blocked = new Set<number>();   // эти люди не запускали бота
  lastId = 100;
  async call(method: string, params: any = {}) {
    this.calls.push({ method, params });
    if ((method === 'sendMessage' || method === 'sendPhoto') && this.blocked.has(params.chat_id)) throw new TgError(403, 'Forbidden: bot was blocked by the user');
    if (method === 'sendMessage' || method === 'sendPhoto') return { message_id: ++this.lastId };
    if (method === 'getMe') return { username: 'mafia_test_bot', supports_inline_queries: true };
    if (method === 'getChatMember') return { status: params.user_id === 1 ? 'creator' : 'member' };
    return true;
  }
  of(method: string) { return this.calls.filter((c) => c.method === method); }
  last(method: string) { return this.of(method).at(-1)?.params; }
  clear() { this.calls = []; }
}

// Среда, 28 октября 2026, 14:44 в Душанбе
let clock = new Date('2026-10-28T09:44:00Z');
function setup() {
  const api = new FakeApi();
  const store = new MemoryBotStore();
  const bot = new Bot({ api, store, botUsername: 'mafia_test_bot', appName: 'play', publicUrl: 'https://mafia.example', now: () => clock });
  bot.inline = true;
  return { api, store, bot };
}

const LEO = { id: 1, first_name: 'Лео', is_bot: false };
const ANYA = { id: 2, first_name: 'Аня', is_bot: false };
const BORIS = { id: 3, first_name: 'Борис', last_name: 'Котов', is_bot: false };
const GROUP = { id: -100, type: 'supergroup', title: 'Мафия по пятницам' };
const priv = (u: { id: number; first_name: string }) => ({ id: u.id, type: 'private', first_name: u.first_name });

let upd = 0;
const msg = (from: object, chat: object, text: string, extra: object = {}) => ({ update_id: ++upd, message: { message_id: ++upd, from, chat, text, ...extra } });
const cb = (from: object, data: string, message?: object, inline?: string) => ({
  update_id: ++upd, callback_query: { id: `cb${upd}`, from, data, ...(message ? { message } : {}), ...(inline ? { inline_message_id: inline } : {}) },
});
const buttons = (p: any): any[] => (p?.reply_markup?.inline_keyboard ?? []).flat();

test('время сбора: дни недели, даты, пояса', () => {
  const tz = 'Asia/Dushanbe';
  const iso = (s: string) => parseWhen(s, clock, tz)?.toISOString();
  assert.equal(iso('21:00'), '2026-10-28T16:00:00.000Z');
  assert.equal(iso('10:00'), '2026-10-29T05:00:00.000Z', 'прошедшее время без дня: завтра');
  assert.equal(iso('завтра в 20:30'), '2026-10-29T15:30:00.000Z');
  assert.equal(iso('в пятницу в 20'), '2026-10-30T15:00:00.000Z');
  assert.equal(iso('сб 19'), '2026-10-31T14:00:00.000Z');
  assert.equal(iso('1.11 20:00'), '2026-11-01T15:00:00.000Z');
  assert.equal(iso('1 ноября 19:30'), '2026-11-01T14:30:00.000Z');
  assert.equal(iso('9 вечера'), '2026-10-28T16:00:00.000Z');
  assert.equal(iso('абракадабра'), undefined);
  assert.equal(iso('25:00'), undefined);
  assert.equal(parseWhen('21:00', clock, 'Europe/Moscow')?.toISOString(), '2026-10-28T18:00:00.000Z');
  assert.equal(formatWhen(new Date('2026-10-30T16:00:00Z'), tz, clock), 'пятница, 30 октября, 21:00');
  assert.equal(formatWhen(new Date('2026-10-28T16:00:00Z'), tz, clock), 'сегодня, 28 октября, 21:00');
});

test('фраза Дона: весь банк по кругу без повторов', () => {
  const seen = new Set(JOKES.map((_, i) => jokeFor(i, -1001).text));
  assert.equal(seen.size, JOKES.length);
  for (const j of JOKES) assert.ok(!/—/.test(j.text), `длинное тире в «${j.text}»`);
});

test('/start: Дон спрашивает про опыт, новичку показывает правила по шагам', async () => {
  const { api, store, bot } = setup();
  await bot.handleUpdate(msg(LEO, priv(LEO), '/start'));
  const photo = api.last('sendPhoto');
  assert.equal(photo.photo, 'https://mafia.example/img/tg-don.jpg');
  assert.match(photo.caption, /ты уже играл/);
  assert.deepEqual(buttons(photo).map((b) => b.callback_data), ['x:newbie', 'x:played', 'x:knows']);
  assert.equal((await store.getUser(1))?.started, true);

  await bot.handleUpdate(cb(LEO, 'x:newbie', { message_id: 5, chat: priv(LEO) }));
  assert.match(api.last('sendMessage').text, /Кто есть кто/);
  assert.equal(buttons(api.last('sendMessage'))[0].callback_data, 't:1');
  await bot.handleUpdate(cb(LEO, 't:3', { message_id: 6, chat: priv(LEO) }));
  const last = api.last('editMessageText');
  assert.match(last.text, /Кто победил/);
  assert.ok(buttons(last).some((b) => b.url === 'https://t.me/mafia_test_bot/play'), 'в конце кнопка сыграть');
  assert.equal((await store.getUser(1))?.experience, 'newbie');

  // Второй раз без вопросов: сразу меню
  api.clear();
  await bot.handleUpdate(msg(LEO, priv(LEO), '/start'));
  assert.equal(api.of('sendPhoto').length, 0);
  assert.match(api.last('sendMessage').text, /С возвращением/);
});

test('/start: игравшему отличия, знающему меню', async () => {
  const { api, bot } = setup();
  await bot.handleUpdate(cb(ANYA, 'x:played', { message_id: 1, chat: priv(ANYA) }));
  assert.match(api.last('sendMessage').text, /отличается от обычной/);
  await bot.handleUpdate(cb(BORIS, 'x:knows', { message_id: 1, chat: priv(BORIS) }));
  const menu = api.last('sendMessage');
  assert.match(menu.text, /без лишних слов/);
  assert.ok(buttons(menu).some((b) => b.switch_inline_query === ''), 'позвать друзей через inline');
});

test('сбор в группе: время ответом, отметки, запас, отмена в два нажатия', async () => {
  const { api, store, bot } = setup();
  await bot.handleUpdate(msg(LEO, priv(LEO), '/start'));
  await bot.handleUpdate(msg(LEO, GROUP, '/sbor@mafia_test_bot'));
  const picker = api.last('sendMessage');
  assert.match(picker.text, /Когда играем/);
  assert.ok(buttons(picker).some((b) => b.callback_data === 'p:0:2100'), 'сегодня 21:00 ещё можно');
  const pickerMsg = { message_id: api.lastId, chat: GROUP };

  // Чужой не может выбрать время
  await bot.handleUpdate(cb(ANYA, 'p:1:2100', pickerMsg));
  assert.match(api.last('answerCallbackQuery').text, /выбирает тот, кто начал/);

  // Своё время ответом
  await bot.handleUpdate(cb(LEO, 'p:other', pickerMsg));
  assert.equal(api.last('sendMessage').reply_markup.force_reply, true);
  await bot.handleUpdate(msg(LEO, GROUP, 'пт 21:00', { reply_to_message: { from: { username: 'mafia_test_bot', is_bot: true } } }));
  const card = api.last('editMessageText');
  assert.match(card.text, /пятница, 30 октября, 21:00 \(Душанбе\)/);
  assert.match(card.text, /Будут: 1 из 10/);
  const g = [...store.gatherings.values()][0];
  assert.equal(g.creatorTgId, 1);
  assert.deepEqual(await store.posts(g.id), [`-100:${pickerMsg.message_id}`]);

  // Аня не запускала бота: «Буду» сразу открывает бота
  api.clear();
  await bot.handleUpdate(cb(ANYA, `g:${g.id}:go`, { message_id: pickerMsg.message_id, chat: GROUP }));
  assert.equal(api.last('answerCallbackQuery').url, `https://t.me/mafia_test_bot?start=g${g.id}`);
  assert.match(api.last('editMessageText').text, /1\. Лео\n2\. Аня/);
  // Запустила бота по ссылке: подтверждение в личке
  await bot.handleUpdate(msg(ANYA, priv(ANYA), `/start g${g.id}`));
  assert.match(api.of('sendMessage').find((c) => c.params.chat_id === 2)!.params.text, /ты в составе/);

  // Борис «может быть», потом набираем 11 «буду»: последний в запасе
  await store.saveUser({ tgId: 3, name: 'Борис К.', started: true, experience: null });
  await bot.handleUpdate(cb(BORIS, `g:${g.id}:maybe`, { message_id: 1, chat: GROUP }));
  assert.match(api.last('answerCallbackQuery').text, /может быть/);
  for (let i = 10; i < 19; i++) {
    await store.saveUser({ tgId: i, name: `Кот ${i}`, started: true, experience: null });
    await bot.handleUpdate(cb({ id: i, first_name: `Кот ${i}` }, `g:${g.id}:go`, { message_id: 1, chat: GROUP }));
  }
  assert.match(api.last('answerCallbackQuery').text, /в запас/);
  const full = (await bot.card(g.id)).text;
  assert.match(full, /Будут: 10 из 10/);
  assert.match(full, /В запасе: Кот 18/);
  assert.match(full, /Может быть: Борис К\./);

  // Отменить может только создатель и только со второго нажатия
  await bot.handleUpdate(cb(ANYA, `g:${g.id}:cancel`, { message_id: 1, chat: GROUP }));
  assert.match(api.last('answerCallbackQuery').text, /только тот, кто его собрал/);
  await bot.handleUpdate(cb(LEO, `g:${g.id}:cancel`, { message_id: 1, chat: GROUP }));
  assert.equal((await store.getGathering(g.id))?.status, 'open');
  api.clear();
  await bot.handleUpdate(cb(LEO, `g:${g.id}:cancel`, { message_id: 1, chat: GROUP }));
  assert.equal((await store.getGathering(g.id))?.status, 'cancelled');
  assert.match(api.last('editMessageText').text, /Сбор отменён/);
  assert.ok(api.of('sendMessage').some((c) => c.params.chat_id === 2 && /отменил сбор/.test(c.params.text)), 'Ане пришло, что сбор отменён');
});

test('напоминания: за час, за 10 минут, стол из сбора, закрытие', async () => {
  const { api, store, bot } = setup();
  for (const u of [LEO, ANYA, BORIS]) await bot.handleUpdate(msg(u, priv(u), '/start'));
  await bot.handleUpdate(msg(LEO, GROUP, '/sbor 21:00'));
  const g = [...store.gatherings.values()][0];
  assert.equal(g.startsAt.toISOString(), '2026-10-28T16:00:00.000Z');
  await bot.handleUpdate(cb(ANYA, `g:${g.id}:go`, { message_id: 1, chat: GROUP }));
  await bot.handleUpdate(cb(BORIS, `g:${g.id}:maybe`, { message_id: 1, chat: GROUP }));
  const dmsTo = (id: number) => api.of('sendMessage').filter((c) => c.params.chat_id === id).map((c) => c.params);

  // Рано: личных напоминаний нет (в группу в 19:30 приходит только фраза дня)
  api.clear();
  clock = new Date('2026-10-28T14:30:00Z');
  await bot.tick();
  assert.equal(api.of('sendMessage').filter((c) => c.params.chat_id > 0).length, 0);

  // За час: состав «буду», а «может быть» спрашиваем
  clock = new Date('2026-10-28T15:01:00Z');
  await bot.tick();
  assert.match(dmsTo(2)[0].text, /Через час мафия.*\nСостав: Лео, Аня/);
  assert.match(dmsTo(3)[0].text, /Ты пока «может быть»/);
  assert.deepEqual(buttons(dmsTo(3)[0]).map((b) => b.callback_data), [`g:${g.id}:go`, `g:${g.id}:no`]);
  api.clear();
  await bot.tick();
  assert.equal(api.of('sendMessage').length, 0, 'второй раз не напоминаем');

  // Аня перестала принимать сообщения: бот это запоминает
  api.blocked.add(2);
  // За 10 минут: организатору кнопка открыть стол, в группу сообщение
  clock = new Date('2026-10-28T15:51:00Z');
  await bot.tick();
  assert.equal(buttons(dmsTo(1)[0])[0].url, `https://t.me/mafia_test_bot/play?startapp=G${g.id}`);
  assert.match(dmsTo(-100)[0].text, /Через 10 минут начинаем! Будут: Лео, Аня/);
  assert.equal((await store.getUser(2))?.started, false);
  api.blocked.clear();

  // Чужой не может открыть стол для сбора
  assert.equal(await bot.roomOpened(g.id, 'MAF-1111', 99), false);
  api.clear();
  assert.equal(await bot.roomOpened(g.id, 'MAF-4821', 1), true);
  assert.equal(buttons(dmsTo(3)[0])[0].url, 'https://t.me/mafia_test_bot/play?startapp=MAF-4821', '«может быть» тоже зовём');
  assert.match(dmsTo(-100)[0].text, /Стол для сбора открыт: <b>MAF-4821<\/b>/);
  assert.ok(buttons(api.last('editMessageText')).some((b) => /Сесть за стол MAF-4821/.test(b.text)), 'на карточке кнопка стола');

  // Через три часа сбор закрывается
  clock = new Date('2026-10-28T19:01:00Z');
  await bot.tick();
  assert.equal((await store.getGathering(g.id))?.status, 'done');
  assert.match(api.last('editMessageText').text, /Сбор прошёл/);
  clock = new Date('2026-10-28T09:44:00Z');
});

test('фраза дня: в группе включена сразу, раз в день вечером, выключает админ', async () => {
  const { api, store, bot } = setup();
  await bot.handleUpdate({ update_id: 1, my_chat_member: { chat: GROUP, from: LEO, old_chat_member: { status: 'left' }, new_chat_member: { status: 'member' } } });
  assert.match(api.last('sendMessage').text, /я Дон/);
  assert.equal((await store.getChat(-100))?.quotes, true);

  api.clear();
  clock = new Date('2026-10-28T13:00:00Z'); // 18:00 в Душанбе: ещё рано
  await bot.tick();
  assert.equal(api.of('sendMessage').length, 0);
  clock = new Date('2026-10-28T14:05:00Z'); // 19:05
  await bot.tick();
  await bot.tick();
  assert.equal(api.of('sendMessage').length, 1, 'одна фраза в день');
  assert.match(api.last('sendMessage').text, /^<b>(Фраза дня|Байка из Палермо|Совет семьи|Из протокола)<\/b>/);

  await bot.handleUpdate(msg(ANYA, GROUP, '/fraza_off'));
  assert.match(api.last('sendMessage').text, /могут админы/);
  await bot.handleUpdate(msg(LEO, GROUP, '/fraza_off'));
  assert.equal((await store.getChat(-100))?.quotes, false);

  // В личке по умолчанию выключено, включается из меню
  await bot.handleUpdate(msg(ANYA, priv(ANYA), '/fraza'));
  assert.equal((await store.getChat(2))?.quotes, false);
  await bot.handleUpdate(cb(ANYA, 'm:qtoggle', { message_id: 1, chat: priv(ANYA) }));
  assert.equal((await store.getChat(2))?.quotes, true);
  clock = new Date('2026-10-28T09:44:00Z');
});

test('inline: карточка приглашения за стол и карточка сбора', async () => {
  const { api, store, bot } = setup();
  bot.opts.roomInfo = (code) => (code === 'MAF-4821' ? { players: 4, host: 'Лео', started: false } : null);
  await bot.handleUpdate({ update_id: 1, inline_query: { id: 'q1', from: ANYA, query: 'maf-4821' } });
  const r = api.last('answerInlineQuery').results[0];
  assert.equal(r.type, 'photo');
  assert.equal(r.photo_url, 'https://mafia.example/img/tg-invite.jpg');
  assert.match(r.caption, /Аня зовёт за стол MAF-4821/);
  assert.match(r.caption, /За столом 4 из 10, ведущий Лео/);
  assert.equal(r.reply_markup.inline_keyboard[0][0].url, 'https://t.me/mafia_test_bot/play?startapp=MAF-4821');

  await bot.handleUpdate(msg(LEO, priv(LEO), '/sbor завтра 20:00'));
  const g = [...store.gatherings.values()][0];
  await bot.handleUpdate({ update_id: 2, inline_query: { id: 'q2', from: LEO, query: `сбор ${g.id}` } });
  const card = api.last('answerInlineQuery').results[0];
  assert.match(card.input_message_content.message_text, /завтра, 29 октября, 20:00/);
  // Нажали «Буду» в карточке, отправленной в другой чат: её тоже обновляем
  await bot.handleUpdate(cb(ANYA, `g:${g.id}:go`, undefined, 'INLINE123'));
  assert.ok((await store.posts(g.id)).includes('i:INLINE123'));
  assert.ok(api.of('editMessageText').some((c) => c.params.inline_message_id === 'INLINE123'));
});

test('webhook: без секрета 401, с секретом сообщение доходит до бота', async () => {
  const { api, bot } = setup();
  const tg = { botToken: '777:secret', botUsername: 'mafia_test_bot', appName: 'play' };
  const srv = await startServer({ port: 0, telegram: tg, bot, gamesFile: null, botTickMs: 3_600_000 });
  const port = (srv.server.address() as AddressInfo).port;
  const secret = webhookSecret(tg.botToken);
  const url = `http://localhost:${port}/tg/${secret}`;
  const body = JSON.stringify(msg(LEO, priv(LEO), '/help'));
  try {
    const bad = await fetch(url, { method: 'POST', body, headers: { 'content-type': 'application/json' } });
    assert.equal(bad.status, 401);
    const ok = await fetch(url, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret } });
    assert.equal(ok.status, 200);
    for (let i = 0; i < 50 && !api.of('sendMessage').length; i++) await new Promise((r) => setTimeout(r, 10));
    assert.match(api.last('sendMessage').text, /Что я умею/);
    const cfg = await (await fetch(`http://localhost:${port}/api/config`)).json();
    assert.equal(cfg.telegram.inline, true);
  } finally {
    await srv.close();
  }
});

// Бот Дона: живое окно с картинками, сборы и напоминания, фраза дня, карточки приглашения, webhook.
// Telegram подменён заглушкой, которая записывает все вызовы.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { Bot, webhookSecret } from '../server/bot/bot.ts';
import { MemoryBotStore } from '../server/bot/store.ts';
import { TgError } from '../server/bot/tgapi.ts';
import type { TgApi } from '../server/bot/tgapi.ts';
import { parseWhen, formatWhen } from '../server/bot/time.ts';
import { JOKES, jokeFor } from '../server/bot/jokes.ts';
import { startServer } from '../server/index.ts';

type Call = { method: string; params: any; file?: string };

class FakeApi implements TgApi {
  calls: Call[] = [];
  blocked = new Set<number>();   // эти люди не запускали бота
  lastId = 100;
  private reply(method: string, params: any, file?: string) {
    this.calls.push({ method, params, file });
    const chat = params.chat_id;
    if ((method === 'sendMessage' || method === 'sendPhoto') && this.blocked.has(chat)) throw new TgError(403, 'Forbidden: bot was blocked by the user');
    const photo = file || params.photo || params.media ? [{ file_id: 'small' }, { file_id: `FILE:${file ?? params.photo ?? params.media?.media}` }] : undefined;
    if (method === 'sendMessage' || method === 'sendPhoto') return { message_id: ++this.lastId, chat: { id: chat }, photo };
    if (method === 'editMessageMedia') return params.inline_message_id ? true : { message_id: params.message_id, photo };
    if (method === 'getMe') return { username: 'mafia_test_bot', supports_inline_queries: true };
    if (method === 'getChatMember') return { status: params.user_id === 1 ? 'creator' : 'member' };
    return true;
  }
  async call(method: string, params: any = {}) { return this.reply(method, params); }
  async upload(method: string, params: any, files: Record<string, string>) {
    assert.ok(existsSync(files.photo), `картинка ${files.photo} есть на диске`);
    return this.reply(method, params, files.photo.split('/').pop());
  }
  of(method: string) { return this.calls.filter((c) => c.method === method); }
  last(method: string) { return this.of(method).at(-1)?.params; }
  /** Все картинки, отправленные в чат: подпись, кнопки и имя картинки. */
  photosTo(chat: number) {
    return this.calls.filter((c) => c.method === 'sendPhoto' && c.params.chat_id === chat).map((c) => ({ ...c.params, image: c.file ?? c.params.photo }));
  }
  /** Последнее изменение сообщения (картинка, подпись, кнопки). */
  lastEdit() {
    const c = this.of('editMessageMedia').at(-1)!;
    return { ...c.params, caption: c.params.media.caption, image: c.file ?? c.params.media.media };
  }
  clear() { this.calls = []; }
}

// Среда, 28 октября 2026, 14:44 в Душанбе
const START = new Date('2026-10-28T09:44:00Z');
let clock = START;
function setup(inline = true) {
  const api = new FakeApi();
  const store = new MemoryBotStore();
  const bot = new Bot({ api, store, botUsername: 'mafia_test_bot', appName: 'play', publicUrl: 'https://mafia.example', now: () => clock });
  bot.inline = inline;
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
  const iso = (s: string) => parseWhen(s, START, tz)?.toISOString();
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
  assert.equal(parseWhen('21:00', START, 'Europe/Moscow')?.toISOString(), '2026-10-28T18:00:00.000Z');
  assert.equal(formatWhen(new Date('2026-10-30T16:00:00Z'), tz, START), 'пятница, 30 октября, 21:00');
  assert.equal(formatWhen(new Date('2026-10-28T16:00:00Z'), tz, START), 'сегодня, 28 октября, 21:00');
});

test('фраза Дона: весь банк по кругу без повторов, у каждой своя картинка', () => {
  const seen = new Set(JOKES.map((_, i) => jokeFor(i, -1001).text));
  assert.equal(seen.size, JOKES.length);
  for (const j of JOKES) assert.ok(!/—/.test(j.text), `длинное тире в «${j.text}»`);
  for (const f of ['don', 'mafia', 'sheriff', 'civilian', 'host', 'saying', 'story', 'tip', 'log']) {
    assert.ok(existsSync(new URL(`../client/src/img/bot/fraza-${f}.jpg`, import.meta.url)), `картинка fraza-${f}`);
  }
});

test('/start: картинка с вопросом, новичку правила в том же окне, команды удаляются', async () => {
  const { api, store, bot } = setup();
  const start = msg(LEO, priv(LEO), '/start');
  await bot.handleUpdate(start);
  assert.ok(api.of('deleteMessage').some((c) => c.params.message_id === start.message.message_id), 'команда /start удалена');
  const hello = api.photosTo(1)[0];
  assert.match(hello.image, /welcome\.jpg$/, 'картинка загружена файлом');
  assert.match(hello.caption, /ты уже играл/);
  assert.deepEqual(buttons(hello).map((b) => b.callback_data), ['x:newbie', 'x:played', 'x:knows']);
  assert.equal((await store.getUser(1))?.started, true);
  const screenId = api.lastId;

  // Новичок: то же сообщение меняется на шаг правил
  await bot.handleUpdate(cb(LEO, 'x:newbie', { message_id: screenId, chat: priv(LEO) }));
  let e = api.lastEdit();
  assert.equal(e.message_id, screenId);
  assert.match(e.image, /tour-1\.jpg$/);
  assert.match(e.caption, /Две команды/);
  assert.deepEqual(buttons(e).map((b) => b.callback_data), ['t:1', 'm:menu']);
  await bot.handleUpdate(cb(LEO, 't:3', { message_id: screenId, chat: priv(LEO) }));
  e = api.lastEdit();
  assert.match(e.image, /tour-4\.jpg$/);
  assert.ok(buttons(e).some((b) => b.url === 'https://t.me/mafia_test_bot/play'), 'в конце кнопка сыграть с ботами');
  assert.equal((await store.getUser(1))?.experience, 'newbie');
  assert.equal(api.of('sendPhoto').length, 1, 'новых сообщений не прибавилось');

  // Картинка, которую уже загружали, второй раз идёт по file_id
  await bot.handleUpdate(cb(LEO, 't:0', { message_id: screenId, chat: priv(LEO) }));
  assert.equal(api.lastEdit().image, 'FILE:tour-1.jpg');

  // Второй /start: старое окно удаляется, внизу меню
  api.clear();
  await bot.handleUpdate(msg(LEO, priv(LEO), '/start'));
  assert.ok(api.of('deleteMessage').some((c) => c.params.message_id === screenId), 'старое окно удалено');
  const menu = api.photosTo(1)[0];
  assert.match(menu.image, /menu\.jpg$/);
  assert.match(menu.caption, /Что делаем, Лео/);
  const invite = buttons(menu).find((b) => /Позвать друзей/.test(b.text));
  assert.deepEqual(invite.switch_inline_query_chosen_chat, { query: '', allow_user_chats: true, allow_group_chats: true });
});

test('меню: игравшему отличия, без inline приглашение ссылкой, статистика и фраза в том же окне', async () => {
  const { api, store, bot } = setup(false);
  await bot.handleUpdate(cb(ANYA, 'x:played', { message_id: 7, chat: priv(ANYA) }));
  assert.match(api.lastEdit().image, /played\.jpg$/);
  assert.match(api.lastEdit().caption, /отличается от обычной/);
  await bot.handleUpdate(cb(BORIS, 'x:knows', { message_id: 8, chat: priv(BORIS) }));
  const menu = api.lastEdit();
  assert.match(menu.image, /menu\.jpg$/);
  assert.match(buttons(menu).find((b) => /Позвать друзей/.test(b.text)).url, /^https:\/\/t\.me\/share\/url\?url=https%3A%2F%2Ft\.me%2Fmafia_test_bot%3Fstart%3Dhi/);

  await bot.handleUpdate(cb(BORIS, 'm:stats', { message_id: 8, chat: priv(BORIS) }));
  assert.match(api.lastEdit().image, /stats\.jpg$/);
  await bot.handleUpdate(cb(BORIS, 'm:fraza', { message_id: 8, chat: priv(BORIS) }));
  assert.match(api.lastEdit().image, /fraza-/);
  assert.deepEqual(buttons(api.lastEdit()).map((b) => b.callback_data), ['m:fraza', 'm:menu']);
  await bot.handleUpdate(cb(BORIS, 'm:qtoggle', { message_id: 8, chat: priv(BORIS) }));
  assert.equal((await store.getChat(3))?.quotes, true);
  assert.ok(buttons(api.lastEdit()).some((b) => /вкл$/.test(b.text)));
  assert.equal(api.of('sendPhoto').length + api.of('sendMessage').length, 0, 'всё в одном окне');
});

test('сбор в группе: время ответом, позвать друзей, живой счёт, уведомления организатору, запас, отмена', async () => {
  const { api, store, bot } = setup(false);
  await bot.handleUpdate(msg(LEO, priv(LEO), '/start'));
  await bot.handleUpdate(msg(LEO, GROUP, '/sbor@mafia_test_bot'));
  const picker = api.photosTo(-100)[0];
  assert.match(picker.image, /picker\.jpg$/);
  assert.ok(buttons(picker).some((b) => b.callback_data === 'p:0:2100'), 'сегодня 21:00 ещё можно');
  const pickerMsg = { message_id: api.lastId, chat: GROUP };

  // Чужой не может выбрать время
  await bot.handleUpdate(cb(ANYA, 'p:1:2100', pickerMsg));
  assert.match(api.last('answerCallbackQuery').text, /выбирает тот, кто начал/);

  // Своё время ответом на вопрос бота; вопрос и ответ потом убираются
  await bot.handleUpdate(cb(LEO, 'p:other', pickerMsg));
  assert.equal(api.last('sendMessage').reply_markup.force_reply, true);
  const promptId = api.lastId;
  const reply = msg(LEO, GROUP, 'пт 21:00', { reply_to_message: { from: { username: 'mafia_test_bot', is_bot: true } } });
  await bot.handleUpdate(reply);
  const deleted = api.of('deleteMessage').map((c) => c.params.message_id);
  assert.ok(deleted.includes(promptId) && deleted.includes(reply.message.message_id), 'вопрос и ответ убраны');
  let card = api.lastEdit();
  assert.equal(card.message_id, pickerMsg.message_id, 'окно выбора стало карточкой');
  assert.match(card.image, /gather-1\.jpg$/, 'на столе одно место занято');
  assert.match(card.caption, /Пятница, 30 октября · 21:00/);
  assert.match(card.caption, /Будут 1\/10:<\/b> Лео/);
  const g = [...store.gatherings.values()][0];
  const share = buttons(card).find((b) => /Позвать друзей/.test(b.text));
  assert.match(decodeURIComponent(share.url), new RegExp(`t\\.me/mafia_test_bot\\?start=g${g.id}`));

  // Аня не запускала бота: «Буду» сразу открывает бота, Лео получает уведомление
  api.clear();
  await bot.handleUpdate(cb(ANYA, `g:${g.id}:go`, pickerMsg));
  assert.equal(api.last('answerCallbackQuery').url, `https://t.me/mafia_test_bot?start=g${g.id}`);
  card = api.lastEdit();
  assert.match(card.image, /gather-2\.jpg$/);
  assert.match(card.caption, /Лео, Аня/);
  assert.match(api.last('sendMessage').text, /Аня<\/b> будет\n.*записались <b>2\/10<\/b>/);
  const firstPing = api.lastId;

  // Аня запустила бота по ссылке: видит ту же карточку у себя
  await bot.handleUpdate(msg(ANYA, priv(ANYA), `/start g${g.id}`));
  const own = api.photosTo(2).at(-1)!;
  assert.match(own.caption, /Будут 2\/10/);
  assert.ok((await store.posts(g.id)).includes(`2:${api.lastId}`), 'карточка у Ани тоже обновляется');

  // Борис «может быть»: прошлое уведомление организатору удалено, пришло новое
  await store.saveUser({ tgId: 3, name: 'Борис К.', started: true, experience: null });
  await bot.handleUpdate(cb(BORIS, `g:${g.id}:maybe`, pickerMsg));
  assert.ok(api.of('deleteMessage').some((c) => c.params.chat_id === 1 && c.params.message_id === firstPing));
  assert.match(api.last('answerCallbackQuery').text, /может быть/);
  for (let i = 10; i < 19; i++) {
    await store.saveUser({ tgId: i, name: `Кот ${i}`, started: true, experience: null });
    await bot.handleUpdate(cb({ id: i, first_name: `Кот ${i}` }, `g:${g.id}:go`, pickerMsg));
  }
  assert.match(api.last('answerCallbackQuery').text, /в запас/);
  const pings = api.of('sendMessage').filter((c) => c.params.chat_id === 1).map((c) => c.params.text);
  assert.ok(pings.some((t) => /можно играть/.test(t)), 'организатору: набралось шестеро');
  assert.ok(pings.some((t) => /Стол полный/.test(t)), 'организатору: стол полный');
  const full = await bot.card(g.id);
  assert.equal(full.image, 'gather-10');
  assert.match(full.caption, /Будут 10\/10/);
  assert.match(full.caption, /Запас: Кот 18/);
  assert.match(full.caption, /Может быть: Борис К\./);

  // Отменить может только создатель и только со второго нажатия
  await bot.handleUpdate(cb(ANYA, `g:${g.id}:cancel`, pickerMsg));
  assert.match(api.last('answerCallbackQuery').text, /только тот, кто его собрал/);
  await bot.handleUpdate(cb(LEO, `g:${g.id}:cancel`, pickerMsg));
  assert.equal((await store.getGathering(g.id))?.status, 'open');
  api.clear();
  await bot.handleUpdate(cb(LEO, `g:${g.id}:cancel`, pickerMsg));
  assert.equal((await store.getGathering(g.id))?.status, 'cancelled');
  assert.match(api.lastEdit().image, /gather-cancelled\.jpg$/);
  assert.ok(api.of('sendMessage').some((c) => c.params.chat_id === 2 && /отменил сбор/.test(c.params.text)), 'Ане пришло, что сбор отменён');
});

test('сбор в личке: окно выбора времени, своё время текстом, мои сборы', async () => {
  const { api, store, bot } = setup();
  await bot.handleUpdate(cb(LEO, 'x:knows', { message_id: 50, chat: priv(LEO) }));
  await bot.handleUpdate(cb(LEO, 'm:sbor', { message_id: 50, chat: priv(LEO) }));
  assert.match(api.lastEdit().image, /picker\.jpg$/);
  await bot.handleUpdate(cb(LEO, 'p:other', { message_id: 50, chat: priv(LEO) }));
  assert.match(api.lastEdit().caption, /Напиши время сообщением/);
  // Непонятное время: подсказка в том же окне
  await bot.handleUpdate(msg(LEO, priv(LEO), 'когда-нибудь'));
  assert.match(api.lastEdit().caption, /Не понял/);
  await bot.handleUpdate(msg(LEO, priv(LEO), 'завтра 20:30'));
  const card = api.lastEdit();
  assert.equal(card.message_id, 50);
  assert.match(card.caption, /Завтра, 29 октября · 20:30/);
  const g = [...store.gatherings.values()][0];
  // Карточка больше не «живое окно»: следующая команда её не удалит
  api.clear();
  await bot.handleUpdate(msg(LEO, priv(LEO), '/start'));
  assert.ok(!api.of('deleteMessage').some((c) => c.params.message_id === 50), 'карточка сбора осталась');
  assert.match(api.photosTo(1)[0].caption, /Ближайший сбор: Завтра, 29 октября · 20:30, записались 1\/10/);
  const menuId = api.lastId;
  await bot.handleUpdate(cb(LEO, 'm:mine', { message_id: menuId, chat: priv(LEO) }));
  const mine = buttons(api.lastEdit());
  assert.equal(mine[0].callback_data, `g:${g.id}:show`);
  await bot.handleUpdate(cb(LEO, `g:${g.id}:show`, { message_id: menuId, chat: priv(LEO) }));
  assert.match(api.photosTo(1).at(-1)!.caption, /Будут 1\/10/);
});

test('напоминания: за час, за 10 минут, стол из сбора, закрытие', async () => {
  const { api, store, bot } = setup();
  for (const u of [LEO, ANYA, BORIS]) await bot.handleUpdate(msg(u, priv(u), '/start'));
  await bot.handleUpdate(msg(LEO, GROUP, '/sbor 21:00'));
  const g = [...store.gatherings.values()][0];
  assert.equal(g.startsAt.toISOString(), '2026-10-28T16:00:00.000Z');
  await bot.handleUpdate(cb(ANYA, `g:${g.id}:go`, { message_id: 1, chat: GROUP }));
  await bot.handleUpdate(cb(BORIS, `g:${g.id}:maybe`, { message_id: 1, chat: GROUP }));

  // Рано: личных напоминаний нет (в группу в 19:30 приходит только фраза дня)
  api.clear();
  clock = new Date('2026-10-28T14:30:00Z');
  await bot.tick();
  assert.equal(api.photosTo(2).length + api.photosTo(3).length, 0);

  // За час: состав «буду», а «может быть» спрашиваем
  clock = new Date('2026-10-28T15:01:00Z');
  await bot.tick();
  assert.match(api.photosTo(2)[0].image, /remind-60\.jpg$/);
  assert.match(api.photosTo(2)[0].caption, /Через час мафия[\s\S]*Состав 2\/10: Лео, Аня/);
  assert.match(api.photosTo(3)[0].caption, /Ты пока «может быть»/);
  assert.deepEqual(buttons(api.photosTo(3)[0]).map((b) => b.callback_data), [`g:${g.id}:go`, `g:${g.id}:no`]);
  api.clear();
  await bot.tick();
  assert.equal(api.photosTo(2).length, 0, 'второй раз не напоминаем');

  // Аня перестала принимать сообщения: бот это запоминает
  api.blocked.add(2);
  clock = new Date('2026-10-28T15:51:00Z');
  await bot.tick();
  const toLeo = api.photosTo(1)[0];
  assert.match(toLeo.image, /remind-10\.jpg$/);
  assert.equal(buttons(toLeo)[0].url, `https://t.me/mafia_test_bot/play?startapp=G${g.id}`);
  assert.match(api.photosTo(-100)[0].caption, /Через 10 минут начинаем![\s\S]*Будут: Лео, Аня/);
  assert.equal((await store.getUser(2))?.started, false);
  api.blocked.clear();

  // Чужой не может открыть стол для сбора
  assert.equal(await bot.roomOpened(g.id, 'MAF-1111', 99), false);
  api.clear();
  assert.equal(await bot.roomOpened(g.id, 'MAF-4821', 1), true);
  assert.match(api.photosTo(3)[0].image, /table-open\.jpg$/);
  assert.equal(buttons(api.photosTo(3)[0])[0].url, 'https://t.me/mafia_test_bot/play?startapp=MAF-4821', '«может быть» тоже зовём');
  assert.match(api.photosTo(-100)[0].caption, /открыл стол MAF-4821/);
  assert.ok(buttons(api.lastEdit()).some((b) => /Сесть за стол MAF-4821/.test(b.text)), 'на карточке кнопка стола');

  // Через три часа сбор закрывается
  clock = new Date('2026-10-28T19:01:00Z');
  await bot.tick();
  assert.equal((await store.getGathering(g.id))?.status, 'done');
  assert.match(api.lastEdit().image, /gather-done\.jpg$/);
  clock = START;
});

test('фраза дня: в группе включена сразу, раз в день вечером с картинкой, выключает админ', async () => {
  const { api, store, bot } = setup();
  await bot.handleUpdate({ update_id: 1, my_chat_member: { chat: GROUP, from: LEO, old_chat_member: { status: 'left' }, new_chat_member: { status: 'member' } } });
  assert.match(api.photosTo(-100)[0].caption, /я Дон/);
  assert.equal((await store.getChat(-100))?.quotes, true);

  api.clear();
  clock = new Date('2026-10-28T13:00:00Z'); // 18:00 в Душанбе: ещё рано
  await bot.tick();
  assert.equal(api.photosTo(-100).length, 0);
  clock = new Date('2026-10-28T14:05:00Z'); // 19:05
  await bot.tick();
  await bot.tick();
  const sent = api.photosTo(-100);
  assert.equal(sent.length, 1, 'одна фраза в день');
  assert.match(sent[0].image, /^fraza-/);
  assert.ok(sent[0].caption.length > 20, 'текст фразы в подписи');

  await bot.handleUpdate(msg(ANYA, GROUP, '/fraza_off'));
  assert.match(api.last('sendMessage').text, /могут админы/);
  await bot.handleUpdate(msg(LEO, GROUP, '/fraza_off'));
  assert.equal((await store.getChat(-100))?.quotes, false);
  clock = START;
});

test('inline: карточка стола, карточка сбора с картинкой стола, обновление в чужом чате', async () => {
  const { api, store, bot } = setup();
  bot.opts.roomInfo = (code) => (code === 'MAF-4821' ? { players: 4, host: 'Лео', started: false } : null);
  await bot.handleUpdate({ update_id: 1, inline_query: { id: 'q1', from: ANYA, query: 'maf-4821' } });
  const r = api.last('answerInlineQuery').results[0];
  assert.equal(r.type, 'photo');
  assert.equal(r.photo_url, 'https://mafia.example/img/bot/table-open.jpg', 'картинку ещё не загружали: по ссылке');
  assert.match(r.caption, /Аня зовёт за стол MAF-4821/);
  assert.match(r.caption, /За столом 4\/10 · 🎙 ведущий Лео/);
  assert.equal(r.reply_markup.inline_keyboard[0][0].url, 'https://t.me/mafia_test_bot/play?startapp=MAF-4821');

  await bot.handleUpdate(msg(LEO, priv(LEO), '/sbor завтра 20:00'));
  const g = [...store.gatherings.values()][0];
  const invite = buttons(api.photosTo(1).at(-1)).find((b) => /Позвать друзей/.test(b.text));
  assert.deepEqual(invite.switch_inline_query_chosen_chat, { query: `сбор ${g.id}`, allow_user_chats: true, allow_group_chats: true });
  await bot.handleUpdate({ update_id: 2, inline_query: { id: 'q2', from: LEO, query: `сбор ${g.id}` } });
  const card = api.last('answerInlineQuery').results[0];
  assert.equal(card.photo_file_id, 'FILE:gather-1.jpg', 'картинка уже в Telegram: по file_id');
  assert.match(card.caption, /Завтра, 29 октября · 20:00/);
  // Нажали «Буду» в карточке, отправленной в другой чат: её тоже обновляем
  await bot.handleUpdate(cb(ANYA, `g:${g.id}:go`, undefined, 'INLINE123'));
  assert.ok((await store.posts(g.id)).includes('i:INLINE123'));
  const inlineEdit = api.of('editMessageMedia').find((c) => c.params.inline_message_id === 'INLINE123')!;
  assert.match(inlineEdit.params.media.media, /gather-2\.jpg$/);
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
    for (let i = 0; i < 50 && !api.of('sendPhoto').length; i++) await new Promise((r) => setTimeout(r, 10));
    assert.match(api.last('sendPhoto').caption, /Что я умею/);
    const cfg = await (await fetch(`http://localhost:${port}/api/config`)).json();
    assert.equal(cfg.telegram.inline, true);
  } finally {
    await srv.close();
  }
});

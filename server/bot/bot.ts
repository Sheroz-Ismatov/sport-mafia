// Бот Дона в Telegram: знакомство с игрой, меню команд, сборы с напоминаниями,
// фраза дня и карточки приглашения. Сообщения приходят через webhook (server/index.ts),
// напоминания и фразы рассылает tick() раз в полминуты.

import { createHash } from 'node:crypto';
import type { BotChat, BotStore, BotUser, Gathering, GatheringMember, MemberStatus } from './store.ts';
import type { TgApi } from './tgapi.ts';
import { TgError, h } from './tgapi.ts';
import { at, cityOf, formatWhen, localHM, nextZone, parseWhen } from './time.ts';
import { jokeFor, jokeText } from './jokes.ts';

export interface BotStats {
  games: number;
  wins: number;
  hosted: number;
  roles: Record<'civilian' | 'sheriff' | 'mafia' | 'don', { games: number; wins: number }>;
}

export interface BotOptions {
  api: TgApi;
  store: BotStore;
  botUsername: string;
  appName: string | null;
  publicUrl: string | null;            // https-адрес сайта: картинки для карточек
  defaultTz?: string;                  // пояс по умолчанию (Душанбе)
  now?: () => Date;
  stats?: (tgId: number) => Promise<BotStats | null>;
  roomInfo?: (code: string) => { players: number; host: string | null; started: boolean } | null;
}

const MAX = 10;
const QUOTE_HOUR = 19;                 // фраза дня приходит вечером, перед играми
const MIN = 60_000;

/** Секрет для адреса webhook и заголовка X-Telegram-Bot-Api-Secret-Token. */
export function webhookSecret(token: string): string {
  return createHash('sha256').update('webhook:' + token).digest('hex').slice(0, 40);
}

type Button = Record<string, unknown>;
type Keyboard = Button[][];

const nameOf = (u: { first_name?: string; last_name?: string }) =>
  [u.first_name ?? 'Игрок', u.last_name ? u.last_name[0] + '.' : ''].filter(Boolean).join(' ').slice(0, 32);

const isGroup = (chat: { type: string }) => chat.type === 'group' || chat.type === 'supergroup';

function plural(n: number, one: string, few: string, many: string): string {
  const d = n % 10, t = n % 100;
  if (d === 1 && t !== 11) return one;
  if (d >= 2 && d <= 4 && (t < 12 || t > 14)) return few;
  return many;
}

// ---------- Тексты Дона ----------

const TOUR = [
  '<b>1. Кто есть кто</b>\n\nЗа столом две команды. Красные: мирные жители и шериф. Чёрные: мафия и её дон. Чёрные знают друг друга, красные не знают никого. Карту ты тянешь сам, и видишь её только ты.',
  '<b>2. День</b>\n\nКаждый по кругу говорит ровно минуту: кому веришь, кого подозреваешь. В свою минуту можно выставить одного игрока на голосование. Потом голосуем, и кто набрал больше всех, уходит из-за стола.',
  '<b>3. Ночь</b>\n\nГород засыпает. Мафия стреляет: убийство засчитают, только если все чёрные выбрали один номер. Потом дон ищет шерифа, а шериф проверяет любого игрока, красный он или чёрный.',
  '<b>4. Кто победил</b>\n\nКрасные выигрывают, когда за столом не осталось чёрных. Чёрные, когда их столько же, сколько красных.\n\nЛучше всего понять игру за столом. Создай стол, нажми «Добрать ботами», и боты сыграют с тобой партию от раздачи до финала.',
];

const PLAYED = `<b>Чем спортивная мафия отличается от обычной</b>

• Речь строго минута, ни секундой больше.
• Выставить можно только в свою минуту и только одного.
• За нарушения ведущий даёт фолы: на третьем молчишь минуту, четвёртый удаляет из игры.
• В первую ночь мафия не стреляет, а договаривается: дон задаёт план отстрела и маяк.
• Первый убитый ночью делает лучший ход: называет номера, кого считает чёрными.
• Если голоса разделились поровну, спорщики оправдываются по 30 секунд, и голосуем снова.

В остальном как обычно: красные против чёрных.`;

const HELP = `<b>Что я умею</b>

/play открыть игру
/sbor собрать игру на время, например <code>/sbor пт 21:00</code>
/rules коротко о правилах
/stats твоя статистика
/fraza фраза Дона прямо сейчас
/fraza_on и /fraza_off фраза дня каждый вечер в этом чате
/help этот список

Добавь меня в чат с друзьями: там удобно собирать игры, а я напомню всем, кто записался.`;

export class Bot {
  readonly opts: Required<Pick<BotOptions, 'defaultTz' | 'now'>> & BotOptions;
  inline = false;      // в BotFather включён inline-режим: карточки можно отправлять в любой чат
  // Выбор времени для нового сбора: кто его начал (только он может нажимать) и в каком поясе
  private pickers = new Map<string, { owner: number; tz: string }>();
  // Ждём своё время ответом: «чат:человек» → сообщение с выбором
  private awaiting = new Map<string, { picker: string; tz: string }>();
  // Отмена сбора в два нажатия
  private cancelArmed = new Map<string, number>();

  constructor(opts: BotOptions) {
    this.opts = { defaultTz: 'Asia/Dushanbe', now: () => new Date(), ...opts };
  }

  private get api() { return this.opts.api; }
  private get store() { return this.opts.store; }

  appLink(param?: string): string {
    const { botUsername, appName } = this.opts;
    return appName ? `https://t.me/${botUsername}/${appName}${param ? `?startapp=${encodeURIComponent(param)}` : ''}` : `https://t.me/${botUsername}`;
  }

  startLink(payload: string): string {
    return `https://t.me/${this.opts.botUsername}?start=${encodeURIComponent(payload)}`;
  }

  private img(name: string): string | null {
    return this.opts.publicUrl ? `${this.opts.publicUrl.replace(/\/$/, '')}/img/${name}` : null;
  }

  // ---------- Настройка при запуске ----------

  /** Webhook, меню команд и описание бота. Вызывается при старте сервера на Render. */
  async setup(webhookUrl: string, secret: string): Promise<void> {
    const me = await this.api.call('getMe');
    this.inline = !!me?.supports_inline_queries;
    await this.api.call('setWebhook', {
      url: webhookUrl, secret_token: secret,
      allowed_updates: ['message', 'callback_query', 'inline_query', 'my_chat_member'],
    });
    const priv = [
      { command: 'play', description: 'Открыть игру' },
      { command: 'sbor', description: 'Собрать игру на время' },
      { command: 'rules', description: 'Коротко о правилах' },
      { command: 'stats', description: 'Моя статистика' },
      { command: 'fraza', description: 'Фраза Дона' },
      { command: 'help', description: 'Что умеет бот' },
    ];
    const group = [
      { command: 'sbor', description: 'Собрать игру на время' },
      { command: 'play', description: 'Открыть игру' },
      { command: 'fraza', description: 'Фраза Дона' },
      { command: 'rules', description: 'Коротко о правилах' },
      { command: 'help', description: 'Что умеет бот' },
    ];
    await this.api.call('setMyCommands', { commands: priv, scope: { type: 'all_private_chats' } });
    await this.api.call('setMyCommands', { commands: group, scope: { type: 'all_group_chats' } });
    await this.api.call('setMyShortDescription', { short_description: 'Спортивная мафия с котиками: стол на 6-10 игроков, голос, сборы с напоминаниями.' }).catch(() => {});
    await this.api.call('setMyDescription', {
      description: 'Я Дон. Здесь играют в спортивную мафию прямо в Telegram: от 6 до 10 игроков, живой ведущий или игра без него, голос и карты с котиками.\n\nНажми «Старт», расскажу, как всё устроено.',
    }).catch(() => {});
  }

  // ---------- Входящие ----------

  async handleUpdate(u: any): Promise<void> {
    try {
      if (u.message) await this.onMessage(u.message);
      else if (u.callback_query) await this.onCallback(u.callback_query);
      else if (u.inline_query) await this.onInline(u.inline_query);
      else if (u.my_chat_member) await this.onMembership(u.my_chat_member);
    } catch (e) {
      console.error('Бот: не удалось обработать сообщение', e);
    }
  }

  private async send(chatId: number, text: string, keyboard?: Keyboard, extra: Record<string, unknown> = {}): Promise<any> {
    return this.api.call('sendMessage', {
      chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true },
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}), ...extra,
    });
  }

  /** Личное сообщение человеку. Если он не запускал бота или заблокировал, отмечаем это и молчим. */
  private async dm(tgId: number, text: string, keyboard?: Keyboard): Promise<boolean> {
    try {
      await this.send(tgId, text, keyboard);
      return true;
    } catch (e) {
      if (e instanceof TgError && (e.code === 403 || e.code === 400)) {
        const u = await this.store.getUser(tgId);
        if (u?.started) await this.store.saveUser({ ...u, started: false });
        return false;
      }
      throw e;
    }
  }

  private async chatOf(chat: { id: number; type: string; title?: string; first_name?: string }): Promise<BotChat> {
    const old = await this.store.getChat(chat.id);
    if (old) return old;
    const c: BotChat = {
      chatId: chat.id, kind: isGroup(chat) ? 'group' : 'private', title: chat.title ?? chat.first_name ?? '',
      quotes: isGroup(chat), tz: this.opts.defaultTz, lastQuoteDay: null, quoteSeq: 0,
    };
    await this.store.saveChat(c);
    return c;
  }

  private async userOf(from: any, started?: boolean): Promise<BotUser> {
    const old = await this.store.getUser(from.id);
    const u: BotUser = { tgId: from.id, name: nameOf(from), started: started ?? old?.started ?? false, experience: old?.experience ?? null };
    if (!old || old.name !== u.name || old.started !== u.started) await this.store.saveUser(u);
    return u;
  }

  private async onMessage(m: any): Promise<void> {
    if (!m.from || m.from.is_bot) return;
    const chat = m.chat;
    await this.chatOf(chat);
    const text: string = (m.text ?? '').trim();

    // Своё время сбора ответом на вопрос бота
    const key = `${chat.id}:${m.from.id}`;
    const waiting = this.awaiting.get(key);
    const replyToBot = m.reply_to_message?.from?.username === this.opts.botUsername;
    if (waiting && text && !text.startsWith('/') && (chat.type === 'private' || replyToBot)) {
      return this.customTime(chat, m.from, text, waiting);
    }

    const cmd = /^\/([a-z_]+)(?:@(\w+))?(?:\s+([\s\S]*))?$/i.exec(text);
    if (!cmd) {
      if (chat.type === 'private') await this.menu(chat.id, m.from, 'Не совсем понял. Вот что могу:');
      return;
    }
    if (cmd[2] && cmd[2].toLowerCase() !== this.opts.botUsername.toLowerCase()) return; // команда другому боту
    const arg = (cmd[3] ?? '').trim();
    switch (cmd[1].toLowerCase()) {
      case 'start': return isGroup(chat) ? this.groupHello(chat.id) : this.start(chat.id, m.from, arg);
      case 'play': return this.play(chat);
      case 'sbor': case 'game': case 'sobrat': return this.newGathering(chat, m.from, arg);
      case 'rules': return this.tour(chat.id, 0);
      case 'stats': return this.statsMsg(chat.id, m.from);
      case 'fraza': case 'quote': return this.quoteNow(chat.id);
      case 'fraza_on': return this.quotesSwitch(chat, m.from, true);
      case 'fraza_off': return this.quotesSwitch(chat, m.from, false);
      case 'help': return void await this.send(chat.id, HELP);
      default:
        if (chat.type === 'private') await this.send(chat.id, HELP);
    }
  }

  /** Бота добавили в группу: здороваемся и предлагаем собрать игру. */
  private async onMembership(u: any): Promise<void> {
    const was = u.old_chat_member?.status;
    const now = u.new_chat_member?.status;
    if (!isGroup(u.chat)) return;
    if ((was === 'left' || was === 'kicked') && (now === 'member' || now === 'administrator')) {
      const c = await this.chatOf(u.chat);
      await this.store.saveChat({ ...c, quotes: true });
      await this.groupHello(u.chat.id);
    }
  }

  private async groupHello(chatId: number): Promise<void> {
    await this.send(chatId,
      `Всем привет, я Дон. Теперь в этом чате можно собирать партии в спортивную мафию.\n\n`
      + `Напишите <code>/sbor пт 21:00</code> или нажмите кнопку ниже: я соберу состав и напомню всем, кто записался. `
      + `А каждый вечер буду присылать фразу дня из жизни нашей семьи (выключить: /fraza_off).`,
      [[{ text: 'Собрать игру', callback_data: 'm:sbor' }, { text: 'Играть', url: this.appLink() }]]);
  }

  // ---------- Знакомство ----------

  private async start(chatId: number, from: any, payload: string): Promise<void> {
    const u = await this.userOf(from, true);
    // Пришёл по кнопке из сбора: теперь можно напоминать
    const g = /^g(\d+)$/.exec(payload);
    if (g) {
      const gathering = await this.store.getGathering(+g[1]);
      if (gathering && gathering.status === 'open') {
        const mine = (await this.store.members(gathering.id)).find((x) => x.tgId === from.id);
        if (!mine) await this.store.setMember(gathering.id, { tgId: from.id, name: u.name, status: 'go' });
        await this.refresh(gathering.id);
        await this.send(chatId, `Готово, ты в составе сбора на ${formatWhen(gathering.startsAt, gathering.tz, this.opts.now())} (${cityOf(gathering.tz)}). Напомню за час и за 10 минут.`);
      }
      if (!u.experience) await this.ask(chatId, from);
      return;
    }
    const table = /^(MAF-\d{4})(-s)?$/i.exec(payload);
    if (table) {
      await this.send(chatId, `Тебя зовут за стол <b>${h(table[1].toUpperCase())}</b>.`, [[{ text: 'Сесть за стол', url: this.appLink(payload.toUpperCase()) }]]);
      return;
    }
    if (u.experience) return this.menu(chatId, from, `С возвращением, ${h(u.name)}. Семья скучала.`);
    await this.ask(chatId, from);
  }

  private async ask(chatId: number, from: any): Promise<void> {
    const caption = `Добро пожаловать в семью, ${h(nameOf(from))}.\n\n`
      + `Я Дон. Здесь играют в спортивную мафию: от 6 до 10 игроков, у каждого своя карта, днём споры и голосование, ночью мафия выходит на охоту. Всё прямо в Telegram, с голосом и котиками.\n\n`
      + `Скажи честно, ты уже играл?`;
    const keyboard: Keyboard = [
      [{ text: 'Я новичок', callback_data: 'x:newbie' }],
      [{ text: 'Играл в обычную мафию', callback_data: 'x:played' }],
      [{ text: 'Знаю спортивные правила', callback_data: 'x:knows' }],
    ];
    const photo = this.img('tg-don.jpg');
    if (photo) {
      try {
        await this.api.call('sendPhoto', { chat_id: chatId, photo, caption, parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
        return;
      } catch {
        // картинка недоступна: просто текстом
      }
    }
    await this.send(chatId, caption, keyboard);
  }

  private tourKeyboard(step: number, inPrivate = true): Keyboard {
    if (step < TOUR.length - 1) return [[{ text: `Дальше (${step + 2} из ${TOUR.length})`, callback_data: `t:${step + 1}` }]];
    const k: Keyboard = [[{ text: 'Сыграть с ботами', url: this.appLink() }], [{ text: 'Собрать игру с друзьями', callback_data: 'm:sbor' }]];
    if (inPrivate) k.push([{ text: 'Подробные правила в игре', url: this.appLink('rules') }]);
    return k;
  }

  private async tour(chatId: number, step: number): Promise<void> {
    await this.send(chatId, TOUR[step], this.tourKeyboard(step, chatId > 0));
  }

  private async menu(chatId: number, from: any, title = 'Что делаем?'): Promise<void> {
    const chat = await this.store.getChat(chatId);
    const k: Keyboard = [
      [{ text: 'Играть', url: this.appLink() }, { text: 'Собрать игру', callback_data: 'm:sbor' }],
    ];
    if (this.inline) k.push([{ text: 'Позвать друзей', switch_inline_query: '' }]);
    k.push([{ text: 'Моя статистика', callback_data: 'm:stats' }, { text: 'Фраза Дона', callback_data: 'm:fraza' }]);
    k.push([{ text: chat?.quotes ? 'Фраза каждый вечер: включена' : 'Присылать фразу каждый вечер', callback_data: 'm:qtoggle' }]);
    void from;
    await this.send(chatId, title, k);
  }

  private async play(chat: any): Promise<void> {
    await this.send(chat.id, 'Стол ждёт. Создай свой или войди по коду друга.', [[{ text: 'Открыть игру', url: this.appLink() }]]);
  }

  private async statsMsg(chatId: number, from: any): Promise<void> {
    const s = this.opts.stats ? await this.opts.stats(from.id).catch(() => null) : null;
    if (!s || (!s.games && !s.hosted)) {
      await this.send(chatId, 'Пока пусто. Сыграй партию с друзьями, открыв игру через Telegram, и здесь появится твоя статистика. Партии с ботами в счёт не идут.',
        [[{ text: 'Играть', url: this.appLink() }]]);
      return;
    }
    const pct = s.games ? Math.round((s.wins / s.games) * 100) : 0;
    const role = (name: string, r: { games: number; wins: number }) => (r.games ? `\n${name}: ${r.wins} из ${r.games}` : '');
    await this.send(chatId, `<b>Статистика ${h(nameOf(from))}</b>\n\n`
      + `Партий: ${s.games}, побед: ${s.wins} (${pct}%)`
      + role('Мирный', s.roles.civilian) + role('Шериф', s.roles.sheriff) + role('Мафия', s.roles.mafia) + role('Дон', s.roles.don)
      + (s.hosted ? `\nПровёл ведущим: ${s.hosted}` : ''));
  }

  // ---------- Фраза Дона ----------

  private async quoteNow(chatId: number): Promise<void> {
    const c = await this.store.getChat(chatId);
    const seq = c?.quoteSeq ?? 0;
    if (c) await this.store.saveChat({ ...c, quoteSeq: seq + 1 });
    await this.send(chatId, jokeText(jokeFor(seq, chatId)), [[{ text: 'Сыграть', url: this.appLink() }]]);
  }

  private async isAdmin(chatId: number, userId: number): Promise<boolean> {
    try {
      const m = await this.api.call('getChatMember', { chat_id: chatId, user_id: userId });
      return m?.status === 'creator' || m?.status === 'administrator';
    } catch {
      return false;
    }
  }

  private async quotesSwitch(chat: any, from: any, on: boolean): Promise<void> {
    if (isGroup(chat) && !(await this.isAdmin(chat.id, from.id))) {
      await this.send(chat.id, 'Включать и выключать фразу дня могут админы чата.');
      return;
    }
    const c = await this.chatOf(chat);
    await this.store.saveChat({ ...c, quotes: on });
    await this.send(chat.id, on
      ? `Договорились: каждый вечер около ${QUOTE_HOUR}:00 (${cityOf(c.tz)}) пришлю фразу из жизни семьи.`
      : 'Хорошо, больше не присылаю. Захочешь вернуть: /fraza_on');
  }

  // ---------- Колбэки кнопок ----------

  private async answer(id: string, text?: string, extra: Record<string, unknown> = {}): Promise<void> {
    await this.api.call('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}), ...extra }).catch(() => {});
  }

  private async onCallback(q: any): Promise<void> {
    const data: string = q.data ?? '';
    const from = q.from;
    const chat = q.message?.chat;
    const [kind, a, b] = data.split(':');

    if (kind === 'x' && chat) {
      const u = await this.userOf(from, true);
      await this.store.saveUser({ ...u, experience: a });
      await this.answer(q.id);
      if (a === 'newbie') return this.tour(chat.id, 0);
      if (a === 'played') {
        await this.send(chat.id, PLAYED, [[{ text: 'Сыграть с ботами', url: this.appLink() }], [{ text: 'Собрать игру с друзьями', callback_data: 'm:sbor' }]]);
        return;
      }
      return this.menu(chat.id, from, 'Тогда без лишних слов. Стол ждёт.');
    }
    if (kind === 't' && chat && q.message) {
      const step = Math.max(0, Math.min(TOUR.length - 1, Number(a) || 0));
      await this.answer(q.id);
      // Листаем в том же сообщении
      await this.api.call('editMessageText', {
        chat_id: chat.id, message_id: q.message.message_id, text: TOUR[step], parse_mode: 'HTML',
        reply_markup: { inline_keyboard: this.tourKeyboard(step, chat.id > 0) },
      }).catch(() => this.tour(chat.id, step));
      return;
    }
    if (kind === 'm' && chat) {
      await this.answer(q.id);
      if (a === 'sbor') return this.newGathering(chat, from, '');
      if (a === 'stats') return this.statsMsg(chat.id, from);
      if (a === 'fraza') return this.quoteNow(chat.id);
      if (a === 'qtoggle') {
        const c = await this.chatOf(chat);
        return this.quotesSwitch(chat, from, !c.quotes);
      }
      return;
    }
    if (kind === 'p') return this.onPicker(q, a, b);
    if (kind === 'g') return this.onGatheringButton(q, Number(a), b);
    await this.answer(q.id);
  }

  // ---------- Сбор: выбор времени ----------

  private pickerKeyboard(tz: string): Keyboard {
    const now = this.opts.now();
    const slot = (day: number, hh: number): Button | null => {
      const d = at(now, tz, day, hh, 0);
      if (d.getTime() - now.getTime() < 15 * MIN) return null;
      return { text: `${day ? 'Завтра' : 'Сегодня'} ${hh}:00`, callback_data: `p:${day}:${hh}00` };
    };
    const rows: Keyboard = [];
    for (const day of [0, 1]) {
      const row = [slot(day, 20), slot(day, 21)].filter(Boolean) as Button[];
      if (row.length) rows.push(row);
    }
    rows.push([{ text: 'Своё время', callback_data: 'p:other' }, { text: `Пояс: ${cityOf(tz)}`, callback_data: 'p:tz' }]);
    rows.push([{ text: 'Отмена', callback_data: 'p:x' }]);
    return rows;
  }

  private pickerText(tz: string): string {
    return `<b>Новый сбор</b>\n\nКогда играем? Время по поясу: ${cityOf(tz)}.\nМожно своё: «пт 21:00», «завтра в 20:30», «1.11 19:00».`;
  }

  private async newGathering(chat: any, from: any, arg: string): Promise<void> {
    const c = await this.chatOf(chat);
    if (arg) {
      const when = parseWhen(arg, this.opts.now(), c.tz);
      if (when && when.getTime() > this.opts.now().getTime()) return this.createGathering(chat, from, when, c.tz, null);
      await this.send(chat.id, 'Не понял время. Например: <code>/sbor пт 21:00</code> или <code>/sbor завтра 20:30</code>.');
      return;
    }
    const msg = await this.send(chat.id, this.pickerText(c.tz), this.pickerKeyboard(c.tz));
    this.pickers.set(`${chat.id}:${msg.message_id}`, { owner: from.id, tz: c.tz });
  }

  private async onPicker(q: any, a: string, b: string): Promise<void> {
    const chat = q.message?.chat;
    if (!chat) return this.answer(q.id);
    const key = `${chat.id}:${q.message.message_id}`;
    const p = this.pickers.get(key);
    if (!p) return this.answer(q.id, 'Это окно устарело. Начни заново: /sbor', { show_alert: true });
    if (p.owner !== q.from.id) return this.answer(q.id, 'Время выбирает тот, кто начал сбор');
    if (a === 'x') {
      this.pickers.delete(key);
      await this.answer(q.id);
      await this.api.call('editMessageText', { chat_id: chat.id, message_id: q.message.message_id, text: 'Сбор отменён.' }).catch(() => {});
      return;
    }
    if (a === 'tz') {
      p.tz = nextZone(p.tz);
      const c = await this.chatOf(chat);
      await this.store.saveChat({ ...c, tz: p.tz });
      await this.answer(q.id, `Пояс: ${cityOf(p.tz)}`);
      await this.api.call('editMessageText', {
        chat_id: chat.id, message_id: q.message.message_id, text: this.pickerText(p.tz), parse_mode: 'HTML',
        reply_markup: { inline_keyboard: this.pickerKeyboard(p.tz) },
      }).catch(() => {});
      return;
    }
    if (a === 'other') {
      await this.answer(q.id);
      this.awaiting.set(`${chat.id}:${q.from.id}`, { picker: key, tz: p.tz });
      await this.send(chat.id, `${h(nameOf(q.from))}, напиши время ответом на это сообщение. Например: пт 21:00, завтра 20:30, 1.11 19:00.`, undefined,
        { reply_markup: { force_reply: true, selective: true, input_field_placeholder: 'пт 21:00' } });
      return;
    }
    const hh = Number(b.slice(0, 2)), mm = Number(b.slice(2));
    const when = at(this.opts.now(), p.tz, Number(a), hh, mm);
    this.pickers.delete(key);
    await this.answer(q.id);
    await this.createGathering(chat, q.from, when, p.tz, q.message.message_id);
  }

  private async customTime(chat: any, from: any, text: string, w: { picker: string; tz: string }): Promise<void> {
    const when = parseWhen(text, this.opts.now(), w.tz);
    if (!when) {
      await this.send(chat.id, 'Не понял время. Напиши, например: пт 21:00 или завтра 20:30.', undefined,
        { reply_markup: { force_reply: true, selective: true, input_field_placeholder: 'пт 21:00' } });
      return;
    }
    if (when.getTime() <= this.opts.now().getTime()) {
      await this.send(chat.id, 'Это время уже прошло. Напиши время впереди, например завтра 20:00.');
      return;
    }
    this.awaiting.delete(`${chat.id}:${from.id}`);
    const pickerId = Number(w.picker.split(':')[1]);
    this.pickers.delete(w.picker);
    await this.createGathering(chat, from, when, w.tz, pickerId);
  }

  private async createGathering(chat: any, from: any, when: Date, tz: string, editMessageId: number | null): Promise<void> {
    const now = this.opts.now().getTime();
    const left = when.getTime() - now;
    const name = nameOf(from);
    await this.userOf(from);
    const g = await this.store.createGathering({
      chatId: chat.id, creatorTgId: from.id, creatorName: name, startsAt: when, tz, status: 'open',
      // Сбор меньше чем за час: напоминание «за час» уже не нужно
      reminded60: left < 60 * MIN, reminded10: left < 10 * MIN, roomCode: null,
    });
    await this.store.setMember(g.id, { tgId: from.id, name, status: 'go' });
    const { text, keyboard } = await this.card(g.id);
    let messageId = editMessageId;
    if (editMessageId) {
      try {
        await this.api.call('editMessageText', { chat_id: chat.id, message_id: editMessageId, text, parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
      } catch {
        messageId = null;
      }
    }
    if (!messageId) messageId = (await this.send(chat.id, text, keyboard)).message_id;
    await this.store.addPost(g.id, `${chat.id}:${messageId}`);
    // Создатель сбора в группе может ещё не запускать бота: подскажем, как получать напоминания
    const u = await this.store.getUser(from.id);
    if (isGroup(chat) && !u?.started) {
      await this.send(chat.id, `${h(name)}, чтобы я напомнил тебе о сборе, открой меня и нажми «Старт».`, [[{ text: 'Получать напоминания', url: this.startLink(`g${g.id}`) }]]);
    }
  }

  // ---------- Сбор: карточка и отметки ----------

  async card(id: number): Promise<{ text: string; keyboard: Keyboard }> {
    const g = (await this.store.getGathering(id))!;
    const members = await this.store.members(id);
    const go = members.filter((m) => m.status === 'go');
    const maybe = members.filter((m) => m.status === 'maybe');
    const no = members.filter((m) => m.status === 'no');
    const now = this.opts.now();
    const head = g.status === 'cancelled' ? '<b>Сбор отменён</b>' : g.status === 'done' ? '<b>Сбор прошёл</b>' : '<b>Сбор на спортивную мафию</b>';
    const lines = [
      head,
      '',
      `Когда: ${formatWhen(g.startsAt, g.tz, now)} (${cityOf(g.tz)})`,
      `Собирает: ${h(g.creatorName)}`,
    ];
    if (g.roomCode && g.status === 'open') lines.push(`Стол открыт: <b>${h(g.roomCode)}</b>`);
    lines.push('', `<b>Будут: ${Math.min(go.length, MAX)} из ${MAX}</b>`);
    const main = go.slice(0, MAX);
    lines.push(main.length ? main.map((m, i) => `${i + 1}. ${h(m.name)}`).join('\n') : 'пока никого');
    if (go.length > MAX) lines.push(`В запасе: ${go.slice(MAX).map((m) => h(m.name)).join(', ')}`);
    if (maybe.length) lines.push(`Может быть: ${maybe.map((m) => h(m.name)).join(', ')}`);
    if (no.length) lines.push(`Не смогут: ${no.map((m) => h(m.name)).join(', ')}`);
    if (g.status === 'open') {
      const need = Math.max(0, 6 - go.length);
      lines.push('', need ? `Для игры нужно хотя бы 6, не хватает ${need}.` : go.length >= MAX ? 'Стол полный, остальные в запасе.' : 'Можно играть, но вдесятером веселее.');
      lines.push('Тем, кто нажал «Буду», напомню за час и за 10 минут.');
    }
    const keyboard: Keyboard = [];
    if (g.status === 'open') {
      if (g.roomCode) keyboard.push([{ text: `Сесть за стол ${g.roomCode}`, url: this.appLink(g.roomCode) }]);
      keyboard.push([
        { text: 'Буду', callback_data: `g:${id}:go` },
        { text: 'Может быть', callback_data: `g:${id}:maybe` },
        { text: 'Не смогу', callback_data: `g:${id}:no` },
      ]);
      if (this.inline) keyboard.push([{ text: 'Позвать в другой чат', switch_inline_query: `сбор ${id}` }]);
      keyboard.push([{ text: 'Отменить сбор', callback_data: `g:${id}:cancel` }]);
    }
    return { text: lines.join('\n'), keyboard };
  }

  /** Обновить карточку сбора везде, где она висит. */
  async refresh(id: number): Promise<void> {
    const { text, keyboard } = await this.card(id);
    for (const ref of await this.store.posts(id)) {
      const target = ref.startsWith('i:') ? { inline_message_id: ref.slice(2) } : { chat_id: Number(ref.split(':')[0]), message_id: Number(ref.split(':')[1]) };
      await this.api.call('editMessageText', { ...target, text, parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } })
        .catch(() => {}); // «не изменилось» или сообщение удалили: не страшно
    }
  }

  private async onGatheringButton(q: any, id: number, action: string): Promise<void> {
    const g = await this.store.getGathering(id);
    if (!g) return this.answer(q.id, 'Сбор не найден');
    // Карточка, отправленная через inline в другой чат: запоминаем, чтобы обновлять и её
    if (q.inline_message_id) await this.store.addPost(id, `i:${q.inline_message_id}`);
    else if (q.message) await this.store.addPost(id, `${q.message.chat.id}:${q.message.message_id}`);
    if (g.status !== 'open') return this.answer(q.id, 'Этот сбор уже закрыт');

    if (action === 'cancel') {
      if (q.from.id !== g.creatorTgId) return this.answer(q.id, 'Отменить сбор может только тот, кто его собрал');
      const armedAt = this.cancelArmed.get(`${id}`);
      if (!armedAt || Date.now() - armedAt > 10_000) {
        this.cancelArmed.set(`${id}`, Date.now());
        return this.answer(q.id, 'Нажми «Отменить сбор» ещё раз, чтобы подтвердить', { show_alert: true });
      }
      this.cancelArmed.delete(`${id}`);
      await this.store.saveGathering({ ...g, status: 'cancelled' });
      await this.answer(q.id, 'Сбор отменён');
      await this.refresh(id);
      for (const m of await this.store.members(id)) {
        if (m.tgId !== g.creatorTgId && m.status !== 'no') {
          await this.dm(m.tgId, `${h(g.creatorName)} отменил сбор на ${formatWhen(g.startsAt, g.tz, this.opts.now())}. В другой раз.`).catch(() => {});
        }
      }
      return;
    }
    const status: MemberStatus | null = action === 'go' || action === 'maybe' || action === 'no' ? action : null;
    if (!status) return this.answer(q.id);
    const user = await this.userOf(q.from);
    await this.store.setMember(id, { tgId: q.from.id, name: user.name, status });
    await this.refresh(id);
    // Напоминания в личку возможны, только если человек запускал бота: иначе сразу открываем бота
    if (status !== 'no' && !user.started) {
      return this.answer(q.id, undefined, { url: this.startLink(`g${id}`) });
    }
    const go = (await this.store.members(id)).filter((m) => m.status === 'go');
    const place = go.findIndex((m) => m.tgId === q.from.id) + 1;
    await this.answer(q.id, status === 'go'
      ? (place > MAX ? `Записал в запас, ты ${place - MAX}-й. Напомню за час и за 10 минут.` : 'Записал: будешь. Напомню за час и за 10 минут.')
      : status === 'maybe' ? 'Записал: может быть. За час спрошу ещё раз.' : 'Жаль. Записал, что не сможешь.');
  }

  /** Создатель (или записавшийся) открыл стол из сбора: зовём всех, кто «Буду» и «Может быть». */
  async roomOpened(id: number, code: string, openerTgId: number): Promise<boolean> {
    const g = await this.store.getGathering(id);
    if (!g || g.status !== 'open') return false;
    const members = await this.store.members(id);
    const allowed = openerTgId === g.creatorTgId || members.some((m) => m.tgId === openerTgId && m.status === 'go');
    if (!allowed) return false;
    await this.store.saveGathering({ ...g, roomCode: code });
    await this.refresh(id);
    const opener = members.find((m) => m.tgId === openerTgId)?.name ?? g.creatorName;
    const button: Keyboard = [[{ text: `Сесть за стол ${code}`, url: this.appLink(code) }]];
    for (const m of members) {
      if (m.tgId !== openerTgId && m.status !== 'no') await this.dm(m.tgId, `${h(opener)} открыл стол <b>${h(code)}</b> для сбора. Садись, начинаем!`, button).catch(() => {});
    }
    if (g.chatId && g.chatId < 0) await this.send(g.chatId, `Стол для сбора открыт: <b>${h(code)}</b>. Садитесь!`, button).catch(() => {});
    return true;
  }

  // ---------- Inline: карточки в любом чате ----------

  private async onInline(q: any): Promise<void> {
    const query: string = (q.query ?? '').trim();
    const results: any[] = [];
    const banner = this.img('tg-invite.jpg');
    const table = /^(MAF-\d{4})(-s)?$/i.exec(query);
    const sbor = /^(?:сбор|g)\s*(\d+)$/i.exec(query);
    if (table) {
      const code = table[1].toUpperCase();
      const spectator = !!table[2];
      const info = this.opts.roomInfo?.(code) ?? null;
      const who = nameOf(q.from);
      const caption = `<b>${h(who)} зовёт ${spectator ? 'посмотреть игру' : 'за стол'} ${code}</b>\n\n`
        + `Спортивная мафия с котиками прямо в Telegram: 6-10 игроков, голос, карты с ролями.`
        + (info ? `\nЗа столом ${info.players} из ${MAX}${info.host ? `, ведущий ${h(info.host)}` : ''}.` : '');
      const keyboard = { inline_keyboard: [[{ text: spectator ? 'Смотреть игру' : 'Сесть за стол', url: this.appLink(code + (spectator ? '-s' : '')) }]] };
      results.push(banner
        ? { type: 'photo', id: `t-${code}`, photo_url: banner, thumbnail_url: banner, title: `Позвать за стол ${code}`, description: 'Карточка с кнопкой «Сесть за стол»', caption, parse_mode: 'HTML', reply_markup: keyboard }
        : { type: 'article', id: `t-${code}`, title: `Позвать за стол ${code}`, input_message_content: { message_text: caption, parse_mode: 'HTML' }, reply_markup: keyboard });
    } else if (sbor) {
      const g = await this.store.getGathering(+sbor[1]);
      if (g && g.status === 'open') {
        const { text, keyboard } = await this.card(g.id);
        results.push({
          type: 'article', id: `g-${g.id}`, title: 'Сбор на спортивную мафию', description: `${formatWhen(g.startsAt, g.tz, this.opts.now())} (${cityOf(g.tz)})`,
          input_message_content: { message_text: text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }, reply_markup: { inline_keyboard: keyboard },
          thumbnail_url: banner ?? undefined,
        });
      }
    } else {
      const caption = '<b>Сыграем в спортивную мафию?</b>\n\nОнлайн-стол с котиками прямо в Telegram: 6-10 игроков, голос, живой ведущий или игра без него.';
      const keyboard = { inline_keyboard: [[{ text: 'Играть', url: this.appLink() }]] };
      results.push(banner
        ? { type: 'photo', id: 'play', photo_url: banner, thumbnail_url: banner, title: 'Позвать в спортивную мафию', description: 'Карточка с кнопкой «Играть»', caption, parse_mode: 'HTML', reply_markup: keyboard }
        : { type: 'article', id: 'play', title: 'Позвать в спортивную мафию', input_message_content: { message_text: caption, parse_mode: 'HTML' }, reply_markup: keyboard });
      const j = jokeFor(Math.floor(Date.now() / 3_600_000), q.from.id);
      results.push({ type: 'article', id: 'fraza', title: 'Фраза Дона', description: j.text.slice(0, 80), input_message_content: { message_text: jokeText(j), parse_mode: 'HTML' }, reply_markup: keyboard });
    }
    await this.api.call('answerInlineQuery', { inline_query_id: q.id, results, cache_time: 0, is_personal: true });
  }

  // ---------- Таймер: напоминания и фраза дня ----------

  /** Нужно ли не давать серверу засыпать: впереди сбор или кто-то ждёт фразу дня. */
  async needsAwake(): Promise<boolean> {
    if ((await this.store.openGatherings()).length) return true;
    return (await this.store.quoteChats()).length > 0;
  }

  async tick(): Promise<void> {
    const now = this.opts.now();
    for (const g of await this.store.openGatherings()) {
      try {
        await this.tickGathering(g, now);
      } catch (e) {
        console.error('Бот: напоминание не ушло', e);
      }
    }
    for (const c of await this.store.quoteChats()) {
      try {
        const t = localHM(now, c.tz);
        if (t.h >= QUOTE_HOUR && t.h < 23 && c.lastQuoteDay !== t.dayKey) {
          await this.store.saveChat({ ...c, lastQuoteDay: t.dayKey, quoteSeq: c.quoteSeq + 1 });
          await this.send(c.chatId, jokeText(jokeFor(c.quoteSeq, c.chatId)), [[{ text: c.kind === 'group' ? 'Собрать игру' : 'Сыграть', ...(c.kind === 'group' ? { callback_data: 'm:sbor' } : { url: this.appLink() }) }]])
            .catch(async (e) => {
              // Бота убрали из чата или заблокировали: больше не пишем туда
              if (e instanceof TgError && (e.code === 403 || e.code === 400)) await this.store.saveChat({ ...c, quotes: false });
            });
        }
      } catch (e) {
        console.error('Бот: фраза дня не ушла', e);
      }
    }
  }

  private async tickGathering(g: Gathering, now: Date): Promise<void> {
    const t = now.getTime();
    const start = g.startsAt.getTime();
    if (t > start + 3 * 3600_000) {
      await this.store.saveGathering({ ...g, status: 'done' });
      await this.refresh(g.id);
      return;
    }
    const members = await this.store.members(g.id);
    const go = members.filter((m) => m.status === 'go');
    const maybe = members.filter((m) => m.status === 'maybe');
    const when = `${formatWhen(g.startsAt, g.tz, now)} (${cityOf(g.tz)})`;

    if (!g.reminded60 && t >= start - 60 * MIN && t < start) {
      await this.store.saveGathering({ ...g, reminded60: true });
      g.reminded60 = true;
      const team = go.slice(0, MAX).map((m) => h(m.name)).join(', ');
      for (const [i, m] of go.entries()) {
        const spare = i >= MAX ? ' Пока ты в запасе, но за столом всякое бывает.' : '';
        await this.dm(m.tgId, `Через час мафия: ${when}.\nСостав: ${team}.${spare}`);
      }
      for (const m of maybe) {
        await this.dm(m.tgId, `Через час сбор на мафию: ${when}. Ты пока «может быть». Будешь?`,
          [[{ text: 'Буду', callback_data: `g:${g.id}:go` }, { text: 'Не смогу', callback_data: `g:${g.id}:no` }]]);
      }
    }
    if (!g.reminded10 && t >= start - 10 * MIN && t < start + 30 * MIN) {
      await this.store.saveGathering({ ...g, reminded10: true });
      const table: Keyboard | undefined = g.roomCode ? [[{ text: `Сесть за стол ${g.roomCode}`, url: this.appLink(g.roomCode) }]] : undefined;
      for (const m of go) {
        if (m.tgId === g.creatorTgId) continue;
        await this.dm(m.tgId, g.roomCode
          ? `Через 10 минут начинаем. Стол уже открыт: <b>${h(g.roomCode)}</b>.`
          : `Через 10 минут начинаем. Как только ${h(g.creatorName)} откроет стол, пришлю кнопку сюда.`, table);
      }
      if (!g.roomCode) {
        await this.dm(g.creatorTgId, `Через 10 минут твой сбор, записалось ${go.length}. Открой стол, а я позову всех, кто записался.`,
          [[{ text: 'Открыть стол для сбора', url: this.appLink(`G${g.id}`) }]]);
      }
      if (g.chatId && g.chatId < 0) {
        await this.send(g.chatId, `Через 10 минут начинаем! Будут: ${go.slice(0, MAX).map((m) => h(m.name)).join(', ') || 'пока никто'}.`, table).catch(() => {});
      }
    }
  }
}

export type { GatheringMember };

// Бот Дона в Telegram.
//
// В личке бот ведёт себя как приложение: одно «живое окно» с картинкой (приветствие, правила,
// меню, статистика, фраза) меняется на месте по кнопкам, команды человека сразу удаляются.
// Остаются только важные сообщения: карточки сборов, напоминания, «стол открыт», фраза дня.
//
// Сбор: карточка с картинкой стола, где места заполняются котами. «Позвать друзей» отправляет
// ссылку (или карточку через inline), друг открывает её и видит ту же карточку с кнопками.
// Карточка обновляется везде сразу, организатору приходит «Аня будет · 5/10».

import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { BotChat, BotStore, BotUser, Gathering, MemberStatus } from './store.ts';
import type { TgApi } from './tgapi.ts';
import { TgError, h } from './tgapi.ts';
import { at, cityOf, formatWhen, localHM, nextZone, parseWhen } from './time.ts';
import { jokeFor } from './jokes.ts';
import type { Joke } from './jokes.ts';

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
  publicUrl: string | null;            // https-адрес сайта: запасной путь к картинкам для inline
  defaultTz?: string;                  // пояс по умолчанию (Душанбе)
  now?: () => Date;
  imageDir?: string;                   // где лежат картинки бота (client/src/img/bot)
  stats?: (tgId: number) => Promise<BotStats | null>;
  roomInfo?: (code: string) => { players: number; host: string | null; started: boolean } | null;
}

const MAX = 10;
const MIN_PLAYERS = 6;
const QUOTE_HOUR = 19;                 // фраза дня приходит вечером, перед играми
const MIN = 60_000;

/** Секрет для адреса webhook и заголовка X-Telegram-Bot-Api-Secret-Token. */
export function webhookSecret(token: string): string {
  return createHash('sha256').update('webhook:' + token).digest('hex').slice(0, 40);
}

type Button = Record<string, unknown>;
type Keyboard = Button[][];
type Target = { chat_id: number; message_id: number } | { inline_message_id: string };

const nameOf = (u: { first_name?: string; last_name?: string }) =>
  [u.first_name ?? 'Игрок', u.last_name ? u.last_name[0] + '.' : ''].filter(Boolean).join(' ').slice(0, 32);
const isGroup = (chat: { type: string }) => chat.type === 'group' || chat.type === 'supergroup';
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** «Пятница, 30 октября · 21:00» */
function whenTitle(g: Gathering, now: Date): string {
  const s = formatWhen(g.startsAt, g.tz, now);
  const i = s.lastIndexOf(', ');
  return cap(s.slice(0, i)) + ' · ' + s.slice(i + 2);
}

// Картинка для фразы: кто говорит или какой это жанр
function jokeImage(j: Joke): string {
  if (j.kind !== 'quote') return `fraza-${j.kind}`;
  const by: Record<string, string> = { 'Дон': 'don', 'Мафия': 'mafia', 'Шериф': 'sheriff', 'Мирный житель': 'civilian', 'Ведущий': 'host' };
  return `fraza-${by[j.by ?? ''] ?? 'saying'}`;
}

function jokeCaption(j: Joke): string {
  // Заголовок («Фраза дня», «Байка из Палермо») уже на картинке
  return j.kind === 'quote' ? `<i>«${h(j.text)}»</i>\n\n<b>${h(j.by ?? '')}</b>` : h(j.text);
}

// ---------- Тексты Дона ----------

const TOUR = [
  'Две команды. <b>Красные</b>: мирные жители и шериф. <b>Чёрные</b>: мафия и дон, они знают друг друга с первой ночи.\n\nКарту тянешь сам, и видишь её только ты.',
  'Каждый по кругу говорит <b>ровно минуту</b>: кому веришь, кого подозреваешь. В свою минуту можно выставить одного игрока.\n\nПотом голосуем, и кто набрал больше всех, уходит из-за стола.',
  'Город засыпает. <b>Мафия стреляет</b>: убийство засчитают, только если все чёрные выбрали один номер.\n\nПотом <b>дон ищет шерифа</b>, а <b>шериф проверяет</b> любого игрока.',
  '<b>Красные</b> выигрывают, когда за столом не осталось чёрных. <b>Чёрные</b>, когда их столько же, сколько красных.\n\nЛучше всего понять игру за столом: создай стол, нажми «Добрать ботами», и боты сыграют с тобой партию.',
];
const TOUR_IMG = ['tour-1', 'tour-2', 'tour-3', 'tour-4'];

const PLAYED = `<b>Чем спортивная мафия отличается от обычной</b>

⏱ Речь строго минута, ни секундой больше
☝️ Выставить можно только в свою минуту и только одного
🟡 Фолы: на третьем молчишь минуту, четвёртый удаляет
🤝 В первую ночь мафия не стреляет, а договаривается: дон задаёт план и маяк
🎯 Первый убитый делает лучший ход: называет, кого считает чёрными
⚖️ Голоса поровну: спорщики оправдываются по 30 секунд, голосуем снова`;

const HELP = `<b>Что я умею</b>

🎲 /play открыть игру
📅 /sbor собрать игру, например <code>/sbor пт 21:00</code>
📖 /rules правила за минуту
📊 /stats твоя статистика
🎭 /fraza фраза Дона
🔔 /fraza_on, /fraza_off фраза каждый вечер в этом чате

Добавь меня в чат с друзьями: там удобно собирать игры, а я напомню всем, кто записался.`;

export class Bot {
  readonly opts: Required<Pick<BotOptions, 'defaultTz' | 'now' | 'imageDir'>> & BotOptions;
  inline = false;      // в BotFather включён inline-режим: карточки можно отправлять в любой чат
  private files = new Map<string, string>();                   // картинка → file_id в Telegram
  private screens = new Map<number, number>();                 // личный чат → сообщение «живого окна»
  private pickers = new Map<string, { owner: number; tz: string }>();     // «чат:сообщение» → выбор времени
  private awaiting = new Map<string, { picker: string; tz: string; prompt: number | null }>(); // ждём своё время
  private cancelArmed = new Map<number, number>();             // отмена сбора в два нажатия
  private pings = new Map<number, number>();                   // сбор → последнее уведомление организатору
  private milestones = new Map<number, number>();              // сбор → о каком числе уже сказали (6 или 10)

  constructor(opts: BotOptions) {
    this.opts = {
      defaultTz: 'Asia/Dushanbe', now: () => new Date(),
      imageDir: fileURLToPath(new URL('../../client/src/img/bot/', import.meta.url)),
      ...opts,
    };
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

  private shareUrl(link: string, text: string): string {
    return `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`;
  }

  private imageUrl(name: string): string | null {
    return this.opts.publicUrl ? `${this.opts.publicUrl.replace(/\/$/, '')}/img/bot/${name}.jpg` : null;
  }

  // ---------- Картинки: загружаем файлом один раз, дальше по file_id ----------

  private remember(name: string, msg: any): void {
    const id = msg?.photo?.at?.(-1)?.file_id;
    if (id) this.files.set(name, id);
  }

  private markup(keyboard?: Keyboard) {
    return keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {};
  }

  /** Отправить картинку с подписью и кнопками. */
  private async photo(chatId: number, image: string, caption: string, keyboard?: Keyboard): Promise<any> {
    const base = { chat_id: chatId, caption, parse_mode: 'HTML', ...this.markup(keyboard) };
    const id = this.files.get(image);
    if (id) {
      try {
        return await this.api.call('sendPhoto', { ...base, photo: id });
      } catch (e) {
        if (!(e instanceof TgError) || e.code !== 400 || !/file|photo/i.test(e.message)) throw e;
        this.files.delete(image); // file_id устарел: загрузим заново
      }
    }
    const msg = await this.api.upload('sendPhoto', base, { photo: `${this.opts.imageDir}${image}.jpg` });
    this.remember(image, msg);
    return msg;
  }

  /** Поменять картинку, подпись и кнопки у сообщения на месте. */
  private async editPhoto(target: Target, image: string, caption: string, keyboard?: Keyboard): Promise<void> {
    const media = (ref: string) => ({ type: 'photo', media: ref, caption, parse_mode: 'HTML' });
    const id = this.files.get(image);
    const params = { ...target, ...this.markup(keyboard) };
    try {
      if (id) {
        await this.api.call('editMessageMedia', { ...params, media: media(id) });
      } else if ('inline_message_id' in target) {
        // В чужой чат через inline файл не загрузить: только по file_id или ссылке
        const url = this.imageUrl(image);
        if (url) await this.api.call('editMessageMedia', { ...params, media: media(url) });
        else await this.api.call('editMessageCaption', { ...params, caption, parse_mode: 'HTML' });
      } else {
        const msg = await this.api.upload('editMessageMedia', { ...params, media: media('attach://photo') }, { photo: `${this.opts.imageDir}${image}.jpg` });
        this.remember(image, msg);
      }
    } catch (e) {
      if (e instanceof TgError && /not modified/i.test(e.message)) return;
      throw e;
    }
  }

  private async text(chatId: number, text: string, keyboard?: Keyboard, extra: Record<string, unknown> = {}): Promise<any> {
    return this.api.call('sendMessage', {
      chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...this.markup(keyboard), ...extra,
    });
  }

  private async del(chatId: number, messageId: number | undefined | null): Promise<void> {
    if (messageId) await this.api.call('deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => {});
  }

  /** Живое окно в личке: по кнопке меняется на месте, по команде старое удаляется и приходит новое внизу. */
  private async screen(chatId: number, image: string, caption: string, keyboard: Keyboard, from?: number): Promise<void> {
    if (from) {
      try {
        await this.editPhoto({ chat_id: chatId, message_id: from }, image, caption, keyboard);
        this.screens.set(chatId, from);
        return;
      } catch {
        // старое сообщение не редактируется: пришлём новое
      }
    }
    if (chatId > 0) await this.del(chatId, this.screens.get(chatId));
    const msg = await this.photo(chatId, image, caption, keyboard);
    if (chatId > 0) this.screens.set(chatId, msg.message_id);
  }

  /** Личное сообщение человеку. Если он не запускал бота или заблокировал, отмечаем это и молчим. */
  private async dm(tgId: number, send: () => Promise<any>): Promise<any> {
    try {
      return await send();
    } catch (e) {
      if (e instanceof TgError && (e.code === 403 || e.code === 400)) {
        const u = await this.store.getUser(tgId);
        if (u?.started) await this.store.saveUser({ ...u, started: false });
        return null;
      }
      throw e;
    }
  }

  // ---------- Настройка при запуске ----------

  /** Webhook, меню команд и описание бота. Вызывается при старте сервера на Render. */
  async setup(webhookUrl: string, secret: string): Promise<void> {
    await this.checkInline();
    await this.api.call('setWebhook', {
      url: webhookUrl, secret_token: secret,
      allowed_updates: ['message', 'callback_query', 'inline_query', 'my_chat_member'],
    });
    const priv = [
      { command: 'start', description: 'Главное меню' },
      { command: 'sbor', description: 'Собрать игру на время' },
      { command: 'play', description: 'Открыть игру' },
      { command: 'rules', description: 'Правила за минуту' },
      { command: 'stats', description: 'Моя статистика' },
      { command: 'fraza', description: 'Фраза Дона' },
    ];
    const group = [
      { command: 'sbor', description: 'Собрать игру на время' },
      { command: 'play', description: 'Открыть игру' },
      { command: 'fraza', description: 'Фраза Дона' },
      { command: 'help', description: 'Что умеет бот' },
    ];
    await this.api.call('setMyCommands', { commands: priv, scope: { type: 'all_private_chats' } });
    await this.api.call('setMyCommands', { commands: group, scope: { type: 'all_group_chats' } });
    await this.api.call('setMyShortDescription', { short_description: 'Спортивная мафия с котиками: стол на 6-10 игроков, голос, сборы с напоминаниями.' }).catch(() => {});
    await this.api.call('setMyDescription', {
      description: 'Я Дон. Здесь играют в спортивную мафию прямо в Telegram: от 6 до 10 игроков, живой ведущий или игра без него, голос и карты с котиками.\n\nНажми «Старт», расскажу, как всё устроено.',
    }).catch(() => {});
  }

  /** Включён ли inline в BotFather. Проверяем при старте и потом раз в час: включение подхватится без перезапуска. */
  async checkInline(): Promise<void> {
    const me = await this.api.call('getMe');
    this.inline = !!me?.supports_inline_queries;
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
    const priv = chat.type === 'private';
    await this.chatOf(chat);
    if (priv) await this.userOf(m.from, true);
    const text: string = (m.text ?? '').trim();

    // Своё время сбора: в личке просто текстом, в группе ответом на вопрос бота
    const key = `${chat.id}:${m.from.id}`;
    const waiting = this.awaiting.get(key);
    const replyToBot = m.reply_to_message?.from?.username === this.opts.botUsername;
    if (waiting && text && !text.startsWith('/') && (priv || replyToBot)) {
      await this.del(chat.id, m.message_id);
      return this.customTime(chat, m.from, text, waiting);
    }

    const cmd = /^\/([a-z_]+)(?:@(\w+))?(?:\s+([\s\S]*))?$/i.exec(text);
    if (cmd?.[2] && cmd[2].toLowerCase() !== this.opts.botUsername.toLowerCase()) return; // команда другому боту
    // В личке команды и случайный текст сразу убираем, чтобы в чате оставалось только нужное.
    // В группе тоже пробуем (получится, если бот админ).
    if (priv || cmd) await this.del(chat.id, m.message_id);
    if (!cmd) {
      if (priv) await this.menu(chat.id, m.from);
      return;
    }
    const arg = (cmd[3] ?? '').trim();
    switch (cmd[1].toLowerCase()) {
      case 'start': return priv ? this.start(chat.id, m.from, arg) : this.groupHello(chat.id);
      case 'menu': return priv ? this.menu(chat.id, m.from) : this.groupHello(chat.id);
      case 'play': return priv ? this.menu(chat.id, m.from) : void await this.text(chat.id, '🎲 Стол ждёт', [[{ text: '🎲 Открыть игру', url: this.appLink() }]]);
      case 'sbor': case 'game': case 'sobrat': return this.newGathering(chat, m.from, arg);
      case 'rules': return priv ? this.tour(chat.id, 0) : void await this.photo(chat.id, TOUR_IMG[0], TOUR[0], [[{ text: '📖 Все правила', url: this.startLink('rules') }]]);
      case 'stats': return priv ? this.statsScreen(chat.id, m.from) : void await this.text(chat.id, 'Статистику показываю в личке.', [[{ text: '📊 Моя статистика', url: this.startLink('stats') }]]);
      case 'fraza': case 'quote': return this.quote(chat.id, priv);
      case 'fraza_on': return this.quotesSwitch(chat, m.from, true);
      case 'fraza_off': return this.quotesSwitch(chat, m.from, false);
      case 'help': return priv ? this.screen(chat.id, 'menu', HELP, [[{ text: '☰ Меню', callback_data: 'm:menu' }]]) : void await this.text(chat.id, HELP);
      default:
        if (priv) await this.menu(chat.id, m.from);
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
    await this.photo(chatId, 'welcome',
      `<b>Всем привет, я Дон</b>\n\nТеперь в этом чате можно собирать партии в спортивную мафию. Напишите <code>/sbor пт 21:00</code> или нажмите кнопку: я соберу состав и напомню всем, кто записался.\n\n🎭 Каждый вечер пришлю фразу из жизни семьи (выключить: /fraza_off)`,
      [[{ text: '📅 Собрать игру', callback_data: 'm:sbor' }], [{ text: '🎲 Играть', url: this.appLink() }]]);
  }

  // ---------- Знакомство и меню ----------

  private async start(chatId: number, from: any, payload: string): Promise<void> {
    const u = await this.userOf(from, true);
    // Друг прислал сбор: показываем карточку с кнопками
    const g = /^g(\d+)$/.exec(payload);
    if (g) {
      const gathering = await this.store.getGathering(+g[1]);
      if (!u.experience) await this.welcome(chatId, from);
      if (gathering) await this.postCard(chatId, gathering.id);
      else await this.text(chatId, 'Этого сбора уже нет.');
      return;
    }
    const table = /^(MAF-\d{4})(-s)?$/i.exec(payload);
    if (table) {
      await this.photo(chatId, 'table-open', `<b>Тебя зовут за стол ${h(table[1].toUpperCase())}</b>`, [[{ text: '🎲 Сесть за стол', url: this.appLink(payload.toUpperCase()) }]]);
      return;
    }
    if (payload === 'rules') return this.tour(chatId, 0);
    if (payload === 'stats') return this.statsScreen(chatId, from);
    if (u.experience) return this.menu(chatId, from);
    await this.welcome(chatId, from);
  }

  private async welcome(chatId: number, from: any, edit?: number): Promise<void> {
    await this.screen(chatId, 'welcome',
      `Привет, <b>${h(nameOf(from))}</b>! Я Дон. Здесь играют в спортивную мафию: от 6 до 10 игроков, днём споры и голосование, ночью мафия выходит на охоту. Всё прямо в Telegram, с голосом и котиками.\n\nСкажи честно, ты уже играл?`,
      [
        [{ text: '🐣 Я новичок', callback_data: 'x:newbie' }],
        [{ text: '🎲 Играл в обычную мафию', callback_data: 'x:played' }],
        [{ text: '🎩 Знаю спортивные правила', callback_data: 'x:knows' }],
      ], edit);
  }

  private tourKeyboard(step: number): Keyboard {
    if (step < TOUR.length - 1) {
      const row: Button[] = [];
      if (step > 0) row.push({ text: '◂ Назад', callback_data: `t:${step - 1}` });
      row.push({ text: 'Дальше ▸', callback_data: `t:${step + 1}` });
      return [row, [{ text: '☰ Меню', callback_data: 'm:menu' }]];
    }
    return [
      [{ text: '🤖 Сыграть с ботами', url: this.appLink() }],
      [{ text: '📅 Собрать игру с друзьями', callback_data: 'm:sbor' }],
      [{ text: '◂ Назад', callback_data: `t:${step - 1}` }, { text: '☰ Меню', callback_data: 'm:menu' }],
    ];
  }

  private async tour(chatId: number, step: number, edit?: number): Promise<void> {
    await this.screen(chatId, TOUR_IMG[step], TOUR[step], this.tourKeyboard(step), edit);
  }

  private async menu(chatId: number, from: any, edit?: number): Promise<void> {
    const chat = await this.store.getChat(chatId);
    const mine = await this.store.userGatherings(from.id);
    const now = this.opts.now();
    let caption = `<b>Что делаем, ${h(nameOf(from))}?</b>`;
    if (mine.length) {
      const g = mine[0];
      const go = (await this.store.members(g.id)).filter((m) => m.status === 'go').length;
      caption += `\n\n📅 Ближайший сбор: ${whenTitle(g, now)}, записались ${go}/${MAX}`;
    }
    const invite: Button = this.inline
      ? { text: '📨 Позвать друзей', switch_inline_query_chosen_chat: { query: '', allow_user_chats: true, allow_group_chats: true } }
      : { text: '📨 Позвать друзей', url: this.shareUrl(this.startLink('hi'), 'Сыграем в спортивную мафию с котиками? Тут Дон всё объяснит') };
    const k: Keyboard = [
      [{ text: '🎲 Играть', url: this.appLink() }, { text: '📅 Собрать игру', callback_data: 'm:sbor' }],
      [{ text: `🗂 Мои сборы${mine.length ? ` (${mine.length})` : ''}`, callback_data: 'm:mine' }, invite],
      [{ text: '📊 Статистика', callback_data: 'm:stats' }, { text: '🎭 Фраза Дона', callback_data: 'm:fraza' }],
      [{ text: '📖 Правила', callback_data: 't:0' }, { text: chat?.quotes ? '🔔 Фраза вечером: вкл' : '🔕 Фраза вечером: выкл', callback_data: 'm:qtoggle' }],
    ];
    await this.screen(chatId, 'menu', caption, k, edit);
  }

  private async statsScreen(chatId: number, from: any, edit?: number): Promise<void> {
    const s = this.opts.stats ? await this.opts.stats(from.id).catch(() => null) : null;
    const back: Keyboard = [[{ text: '🎲 Играть', url: this.appLink() }, { text: '☰ Меню', callback_data: 'm:menu' }]];
    if (!s || (!s.games && !s.hosted)) {
      return this.screen(chatId, 'stats', `<b>Досье пока пустое</b>\n\nСыграй партию с друзьями, открыв игру через Telegram, и здесь появится твоя статистика. Партии с ботами в счёт не идут.`, back, edit);
    }
    const pct = s.games ? Math.round((s.wins / s.games) * 100) : 0;
    const role = (icon: string, name: string, r: { games: number; wins: number }) => (r.games ? `\n${icon} ${name}: ${r.wins} из ${r.games}` : '');
    await this.screen(chatId, 'stats', `<b>Досье: ${h(nameOf(from))}</b>\n\n🎲 Партий: <b>${s.games}</b>\n🏆 Побед: <b>${s.wins}</b> (${pct}%)\n`
      + role('🔴', 'Мирный', s.roles.civilian) + role('⭐', 'Шериф', s.roles.sheriff) + role('⚫', 'Мафия', s.roles.mafia) + role('👑', 'Дон', s.roles.don)
      + (s.hosted ? `\n\n🎙 Провёл ведущим: ${s.hosted}` : ''), back, edit);
  }

  private async mineScreen(chatId: number, from: any, edit?: number): Promise<void> {
    const list = await this.store.userGatherings(from.id);
    const now = this.opts.now();
    const k: Keyboard = [];
    for (const g of list.slice(0, 6)) {
      const go = (await this.store.members(g.id)).filter((m) => m.status === 'go').length;
      k.push([{ text: `📅 ${whenTitle(g, now)} · ${go}/${MAX}`, callback_data: `g:${g.id}:show` }]);
    }
    k.push([{ text: '➕ Новый сбор', callback_data: 'm:sbor' }, { text: '☰ Меню', callback_data: 'm:menu' }]);
    await this.screen(chatId, 'picker', list.length
      ? `<b>Твои сборы</b>\n\nНажми на сбор, и я пришлю его карточку: там видно, кто записался, и есть кнопка позвать друзей.`
      : `<b>Сборов пока нет</b>\n\nСобери игру: выбери время, позови друзей, а я напомню всем, кто записался.`, k, edit);
  }

  // ---------- Фраза Дона ----------

  private async nextJoke(chatId: number): Promise<Joke> {
    const c = await this.store.getChat(chatId);
    const seq = c?.quoteSeq ?? 0;
    if (c) await this.store.saveChat({ ...c, quoteSeq: seq + 1 });
    return jokeFor(seq, chatId);
  }

  private async quote(chatId: number, priv: boolean, edit?: number): Promise<void> {
    const j = await this.nextJoke(chatId);
    if (priv) {
      return this.screen(chatId, jokeImage(j), jokeCaption(j), [[{ text: '🎭 Ещё', callback_data: 'm:fraza' }, { text: '☰ Меню', callback_data: 'm:menu' }]], edit);
    }
    await this.photo(chatId, jokeImage(j), jokeCaption(j), [[{ text: '📅 Собрать игру', callback_data: 'm:sbor' }]]);
  }

  private async isAdmin(chatId: number, userId: number): Promise<boolean> {
    try {
      const m = await this.api.call('getChatMember', { chat_id: chatId, user_id: userId });
      return m?.status === 'creator' || m?.status === 'administrator';
    } catch {
      return false;
    }
  }

  private async quotesSwitch(chat: any, from: any, on: boolean, edit?: number): Promise<void> {
    if (isGroup(chat) && !(await this.isAdmin(chat.id, from.id))) {
      await this.text(chat.id, 'Включать и выключать фразу дня могут админы чата.');
      return;
    }
    const c = await this.chatOf(chat);
    await this.store.saveChat({ ...c, quotes: on });
    if (!isGroup(chat)) return this.menu(chat.id, from, edit);
    await this.text(chat.id, on
      ? `🔔 Договорились: каждый вечер около ${QUOTE_HOUR}:00 (${cityOf(c.tz)}) пришлю фразу из жизни семьи.`
      : '🔕 Хорошо, больше не присылаю. Вернуть: /fraza_on');
  }

  // ---------- Кнопки ----------

  private async answer(id: string, text?: string, extra: Record<string, unknown> = {}): Promise<void> {
    await this.api.call('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}), ...extra }).catch(() => {});
  }

  private async onCallback(q: any): Promise<void> {
    const data: string = q.data ?? '';
    const from = q.from;
    const chat = q.message?.chat;
    const msgId: number | undefined = q.message?.message_id;
    const priv = chat?.type === 'private';
    const [kind, a, b] = data.split(':');

    if (kind === 'x' && chat) {
      const u = await this.userOf(from, true);
      await this.store.saveUser({ ...u, experience: a });
      await this.answer(q.id);
      if (a === 'newbie') return this.tour(chat.id, 0, msgId);
      if (a === 'played') {
        return this.screen(chat.id, 'played', PLAYED, [
          [{ text: '🤖 Сыграть с ботами', url: this.appLink() }],
          [{ text: '📅 Собрать игру с друзьями', callback_data: 'm:sbor' }],
          [{ text: '☰ Меню', callback_data: 'm:menu' }],
        ], msgId);
      }
      return this.menu(chat.id, from, msgId);
    }
    if (kind === 't' && chat) {
      await this.answer(q.id);
      const step = Math.max(0, Math.min(TOUR.length - 1, Number(a) || 0));
      if (!priv) return void await this.photo(chat.id, TOUR_IMG[step], TOUR[step]);
      return this.tour(chat.id, step, msgId);
    }
    if (kind === 'm' && chat) {
      await this.answer(q.id);
      if (a === 'sbor') return this.newGathering(chat, from, '', priv ? msgId : undefined);
      if (!priv) return; // остальное меню только в личке
      if (a === 'menu') return this.menu(chat.id, from, msgId);
      if (a === 'stats') return this.statsScreen(chat.id, from, msgId);
      if (a === 'fraza') return this.quote(chat.id, true, msgId);
      if (a === 'mine') return this.mineScreen(chat.id, from, msgId);
      if (a === 'qtoggle') {
        const c = await this.chatOf(chat);
        return this.quotesSwitch(chat, from, !c.quotes, msgId);
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
      return { text: `${day ? '🌙 Завтра' : '☀️ Сегодня'} ${hh}:00`, callback_data: `p:${day}:${hh}00` };
    };
    const rows: Keyboard = [];
    for (const day of [0, 1]) {
      const row = [slot(day, 20), slot(day, 21)].filter(Boolean) as Button[];
      if (row.length) rows.push(row);
    }
    rows.push([{ text: '✍️ Своё время', callback_data: 'p:other' }, { text: `🌍 ${cityOf(tz)}`, callback_data: 'p:tz' }]);
    rows.push([{ text: '✖ Отмена', callback_data: 'p:x' }]);
    return rows;
  }

  private pickerText(tz: string, asking = false): string {
    return asking
      ? `✍️ Напиши время сообщением, например: <code>пт 21:00</code>, <code>завтра 20:30</code>, <code>1.11 19:00</code>\n🌍 Пояс: ${cityOf(tz)}`
      : `Выбери время или напиши своё.\n🌍 Пояс: ${cityOf(tz)}`;
  }

  private async newGathering(chat: any, from: any, arg: string, edit?: number): Promise<void> {
    const c = await this.chatOf(chat);
    if (arg) {
      const when = parseWhen(arg, this.opts.now(), c.tz);
      if (when && when.getTime() > this.opts.now().getTime()) return this.createGathering(chat, from, when, c.tz, null);
      await this.text(chat.id, '🤔 Не понял время. Например: <code>/sbor пт 21:00</code> или <code>/sbor завтра 20:30</code>.');
      return;
    }
    let messageId: number;
    if (chat.type === 'private') {
      await this.screen(chat.id, 'picker', this.pickerText(c.tz), this.pickerKeyboard(c.tz), edit);
      messageId = this.screens.get(chat.id)!;
    } else {
      messageId = (await this.photo(chat.id, 'picker', this.pickerText(c.tz), this.pickerKeyboard(c.tz))).message_id;
    }
    this.pickers.set(`${chat.id}:${messageId}`, { owner: from.id, tz: c.tz });
  }

  private async onPicker(q: any, a: string, b: string): Promise<void> {
    const chat = q.message?.chat;
    if (!chat) return this.answer(q.id);
    const msgId = q.message.message_id;
    const key = `${chat.id}:${msgId}`;
    const p = this.pickers.get(key);
    if (!p) return this.answer(q.id, 'Это окно устарело. Начни заново: /sbor', { show_alert: true });
    if (p.owner !== q.from.id) return this.answer(q.id, 'Время выбирает тот, кто начал сбор');
    const target = { chat_id: chat.id, message_id: msgId };
    if (a === 'x') {
      this.pickers.delete(key);
      this.awaiting.delete(`${chat.id}:${q.from.id}`);
      await this.answer(q.id, 'Сбор отменён');
      if (chat.type === 'private') return this.menu(chat.id, q.from, msgId);
      await this.del(chat.id, msgId);
      return;
    }
    if (a === 'tz') {
      p.tz = nextZone(p.tz);
      const c = await this.chatOf(chat);
      await this.store.saveChat({ ...c, tz: p.tz });
      await this.answer(q.id, `Пояс: ${cityOf(p.tz)}`);
      await this.editPhoto(target, 'picker', this.pickerText(p.tz), this.pickerKeyboard(p.tz)).catch(() => {});
      return;
    }
    if (a === 'other') {
      await this.answer(q.id);
      let prompt: number | null = null;
      if (chat.type === 'private') {
        await this.editPhoto(target, 'picker', this.pickerText(p.tz, true), [[{ text: '◂ Назад к выбору', callback_data: 'p:back' }, { text: '✖ Отмена', callback_data: 'p:x' }]]).catch(() => {});
      } else {
        // В группе бот видит только ответы на свои сообщения: просим ответить
        prompt = (await this.text(chat.id, `${h(nameOf(q.from))}, ответь на это сообщение временем, например: <code>пт 21:00</code>`, undefined,
          { reply_markup: { force_reply: true, selective: true, input_field_placeholder: 'пт 21:00' } })).message_id;
      }
      this.awaiting.set(`${chat.id}:${q.from.id}`, { picker: key, tz: p.tz, prompt });
      return;
    }
    if (a === 'back') {
      await this.answer(q.id);
      this.awaiting.delete(`${chat.id}:${q.from.id}`);
      await this.editPhoto(target, 'picker', this.pickerText(p.tz), this.pickerKeyboard(p.tz)).catch(() => {});
      return;
    }
    const hh = Number(b.slice(0, 2)), mm = Number(b.slice(2));
    const when = at(this.opts.now(), p.tz, Number(a), hh, mm);
    this.pickers.delete(key);
    await this.answer(q.id);
    await this.createGathering(chat, q.from, when, p.tz, msgId);
  }

  private async customTime(chat: any, from: any, text: string, w: { picker: string; tz: string; prompt: number | null }): Promise<void> {
    const when = parseWhen(text, this.opts.now(), w.tz);
    const pickerId = Number(w.picker.split(':')[1]);
    const problem = !when ? `🤔 Не понял «${h(text.slice(0, 40))}». Напиши, например: <code>пт 21:00</code> или <code>завтра 20:30</code>`
      : when.getTime() <= this.opts.now().getTime() ? '⏳ Это время уже прошло. Напиши время впереди, например <code>завтра 20:00</code>' : null;
    if (problem) {
      if (chat.type === 'private') {
        await this.editPhoto({ chat_id: chat.id, message_id: pickerId }, 'picker', `${this.pickerText(w.tz, true)}\n\n${problem}`,
          [[{ text: '◂ Назад к выбору', callback_data: 'p:back' }, { text: '✖ Отмена', callback_data: 'p:x' }]]).catch(() => {});
      } else {
        await this.del(chat.id, w.prompt);
        const prompt = (await this.text(chat.id, problem, undefined, { reply_markup: { force_reply: true, selective: true, input_field_placeholder: 'пт 21:00' } })).message_id;
        this.awaiting.set(`${chat.id}:${from.id}`, { ...w, prompt });
      }
      return;
    }
    this.awaiting.delete(`${chat.id}:${from.id}`);
    this.pickers.delete(w.picker);
    await this.del(chat.id, w.prompt);
    await this.createGathering(chat, from, when!, w.tz, pickerId);
  }

  private async createGathering(chat: any, from: any, when: Date, tz: string, editMessageId: number | null): Promise<void> {
    const left = when.getTime() - this.opts.now().getTime();
    const name = nameOf(from);
    await this.userOf(from);
    const g = await this.store.createGathering({
      chatId: chat.id, creatorTgId: from.id, creatorName: name, startsAt: when, tz, status: 'open',
      // Сбор меньше чем за час: напоминание «за час» уже не нужно
      reminded60: left < 60 * MIN, reminded10: left < 10 * MIN, roomCode: null,
    });
    await this.store.setMember(g.id, { tgId: from.id, name, status: 'go' });
    // Окно выбора времени превращается в карточку сбора и больше не «живое окно»
    if (editMessageId && this.screens.get(chat.id) === editMessageId) this.screens.delete(chat.id);
    let placed = false;
    if (editMessageId) {
      const { image, caption, keyboard } = await this.card(g.id);
      try {
        await this.editPhoto({ chat_id: chat.id, message_id: editMessageId }, image, caption, keyboard);
        await this.store.addPost(g.id, `${chat.id}:${editMessageId}`);
        placed = true;
      } catch {
        // не вышло отредактировать: пришлём новую карточку
      }
    }
    if (!placed) await this.postCard(chat.id, g.id);
    // Создатель сбора в группе может ещё не запускать бота: подскажем, как получать напоминания
    const u = await this.store.getUser(from.id);
    if (isGroup(chat) && !u?.started) {
      await this.text(chat.id, `${h(name)}, чтобы я напомнил тебе о сборе и рассказал, кто записался, открой меня и нажми «Старт».`,
        [[{ text: '🔔 Получать напоминания', url: this.startLink(`g${g.id}`) }]]);
    }
  }

  // ---------- Сбор: карточка ----------

  /** Карточка сбора: картинка стола с заполненными местами, подпись с составом и кнопки. */
  async card(id: number): Promise<{ image: string; caption: string; keyboard: Keyboard }> {
    const g = (await this.store.getGathering(id))!;
    const members = await this.store.members(id);
    const go = members.filter((m) => m.status === 'go');
    const maybe = members.filter((m) => m.status === 'maybe');
    const no = members.filter((m) => m.status === 'no');
    const now = this.opts.now();
    const names = (list: typeof go) => list.map((m) => h(m.name)).join(', ');
    const image = g.status === 'cancelled' ? 'gather-cancelled' : g.status === 'done' ? 'gather-done' : `gather-${Math.min(go.length, MAX)}`;

    const lines: string[] = [];
    if (g.status === 'cancelled') lines.push('<b>❌ Сбор отменён</b>', '');
    if (g.status === 'done') lines.push('<b>Сбор прошёл</b>', '');
    lines.push(`<b>📅 ${whenTitle(g, now)}</b>`, `🌍 по времени: ${cityOf(g.tz)}`, `🎩 Собирает ${h(g.creatorName)}`, '');
    lines.push(`✅ <b>Будут ${Math.min(go.length, MAX)}/${MAX}:</b> ${go.length ? names(go.slice(0, MAX)) : 'пока никого'}`);
    if (go.length > MAX) lines.push(`🪑 Запас: ${names(go.slice(MAX))}`);
    if (maybe.length) lines.push(`🤔 Может быть: ${names(maybe)}`);
    if (no.length) lines.push(`❌ Не смогут: ${names(no)}`);
    if (g.status === 'open') {
      lines.push('');
      if (g.roomCode) lines.push(`🎲 Стол открыт: <b>${h(g.roomCode)}</b>, садись!`);
      else if (go.length < MIN_PLAYERS) lines.push(`🪑 До старта не хватает ${MIN_PLAYERS - go.length}. Позови друзей кнопкой ниже`);
      else lines.push(go.length >= MAX ? '🔥 Стол полный! Остальные в запасе' : '🎉 Можно играть, но вдесятером веселее');
      if (!g.roomCode) lines.push('🔔 Напомню за час и за 10 минут');
    }
    let caption = lines.join('\n');
    if (caption.length > 1000) caption = caption.slice(0, 990) + '…';

    const keyboard: Keyboard = [];
    if (g.status === 'open') {
      if (g.roomCode) keyboard.push([{ text: `🎲 Сесть за стол ${g.roomCode}`, url: this.appLink(g.roomCode) }]);
      keyboard.push([
        { text: '✅ Буду', callback_data: `g:${id}:go` },
        { text: '🤔 Может', callback_data: `g:${id}:maybe` },
        { text: '❌ Не смогу', callback_data: `g:${id}:no` },
      ]);
      keyboard.push([this.inline
        ? { text: '📨 Позвать друзей', switch_inline_query_chosen_chat: { query: `сбор ${id}`, allow_user_chats: true, allow_group_chats: true } }
        : { text: '📨 Позвать друзей', url: this.shareUrl(this.startLink(`g${id}`), `Собираемся на спортивную мафию: ${whenTitle(g, now)} (${cityOf(g.tz)}). Записывайся!`) }]);
      keyboard.push([{ text: '✖ Отменить сбор', callback_data: `g:${id}:cancel` }]);
    }
    return { image, caption, keyboard };
  }

  /** Прислать карточку сбора в чат и запомнить её, чтобы обновлять. */
  private async postCard(chatId: number, id: number): Promise<void> {
    const { image, caption, keyboard } = await this.card(id);
    const msg = await this.photo(chatId, image, caption, keyboard);
    await this.store.addPost(id, `${chatId}:${msg.message_id}`);
  }

  /** Обновить карточку сбора везде, где она висит. Сначала обычные сообщения: так у inline-копий будет file_id. */
  async refresh(id: number): Promise<void> {
    const { image, caption, keyboard } = await this.card(id);
    const refs = (await this.store.posts(id)).sort((x, y) => Number(x.startsWith('i:')) - Number(y.startsWith('i:')));
    for (const ref of refs) {
      const target: Target = ref.startsWith('i:') ? { inline_message_id: ref.slice(2) } : { chat_id: Number(ref.split(':')[0]), message_id: Number(ref.split(':')[1]) };
      await this.editPhoto(target, image, caption, keyboard).catch(() => {}); // сообщение удалили: не страшно
    }
  }

  private async onGatheringButton(q: any, id: number, action: string): Promise<void> {
    const g = await this.store.getGathering(id);
    if (!g) return this.answer(q.id, 'Сбор не найден');
    if (action === 'show') {
      await this.answer(q.id);
      if (q.message) await this.postCard(q.message.chat.id, id);
      return;
    }
    // Карточка, отправленная через inline в другой чат: запоминаем, чтобы обновлять и её
    if (q.inline_message_id) await this.store.addPost(id, `i:${q.inline_message_id}`);
    else if (q.message) await this.store.addPost(id, `${q.message.chat.id}:${q.message.message_id}`);
    if (g.status !== 'open') return this.answer(q.id, 'Этот сбор уже закрыт');

    if (action === 'cancel') {
      if (q.from.id !== g.creatorTgId) return this.answer(q.id, 'Отменить сбор может только тот, кто его собрал');
      const armedAt = this.cancelArmed.get(id);
      if (!armedAt || Date.now() - armedAt > 10_000) {
        this.cancelArmed.set(id, Date.now());
        return this.answer(q.id, 'Нажми «Отменить сбор» ещё раз, чтобы подтвердить', { show_alert: true });
      }
      this.cancelArmed.delete(id);
      await this.store.saveGathering({ ...g, status: 'cancelled' });
      await this.answer(q.id, 'Сбор отменён');
      await this.refresh(id);
      for (const m of await this.store.members(id)) {
        if (m.tgId !== g.creatorTgId && m.status !== 'no') {
          await this.dm(m.tgId, () => this.text(m.tgId, `❌ ${h(g.creatorName)} отменил сбор на ${formatWhen(g.startsAt, g.tz, this.opts.now())}. В другой раз!`)).catch(() => {});
        }
      }
      return;
    }
    const status: MemberStatus | null = action === 'go' || action === 'maybe' || action === 'no' ? action : null;
    if (!status) return this.answer(q.id);
    const user = await this.userOf(q.from);
    const before = (await this.store.members(id)).find((m) => m.tgId === q.from.id)?.status;
    await this.store.setMember(id, { tgId: q.from.id, name: user.name, status });
    await this.refresh(id);
    if (before !== status && q.from.id !== g.creatorTgId) await this.pingCreator(g, user.name, status);
    // Напоминания в личку возможны, только если человек запускал бота: иначе сразу открываем бота
    if (status !== 'no' && !user.started) return this.answer(q.id, undefined, { url: this.startLink(`g${id}`) });
    const go = (await this.store.members(id)).filter((m) => m.status === 'go');
    const place = go.findIndex((m) => m.tgId === q.from.id) + 1;
    await this.answer(q.id, status === 'go'
      ? (place > MAX ? `🪑 Записал в запас, ты ${place - MAX}-й. Напомню за час и за 10 минут` : '✅ Записал: будешь. Напомню за час и за 10 минут')
      : status === 'maybe' ? '🤔 Записал: может быть. За час спрошу ещё раз' : '❌ Жаль. Записал, что не сможешь');
  }

  /** Организатору: кто записался и сколько уже. Старое уведомление удаляем, чтобы в чате было только свежее. */
  private async pingCreator(g: Gathering, name: string, status: MemberStatus): Promise<void> {
    const creator = await this.store.getUser(g.creatorTgId);
    if (!creator?.started) return;
    const go = (await this.store.members(g.id)).filter((m) => m.status === 'go').length;
    const what = status === 'go' ? `✅ <b>${h(name)}</b> будет` : status === 'maybe' ? `🤔 <b>${h(name)}</b>: может быть` : `❌ <b>${h(name)}</b> не сможет`;
    let text = `${what}\n📅 ${whenTitle(g, this.opts.now())} · записались <b>${Math.min(go, MAX)}/${MAX}</b>`;
    const said = this.milestones.get(g.id) ?? 0;
    if (go >= MAX && said < MAX) { text += '\n\n🔥 Стол полный, можно начинать!'; this.milestones.set(g.id, MAX); }
    else if (go >= MIN_PLAYERS && said < MIN_PLAYERS) { text += '\n\n🎉 Набралось шестеро, можно играть!'; this.milestones.set(g.id, MIN_PLAYERS); }
    await this.del(g.creatorTgId, this.pings.get(g.id));
    const msg = await this.dm(g.creatorTgId, () => this.text(g.creatorTgId, text, [[{ text: '📋 Карточка сбора', callback_data: `g:${g.id}:show` }]])).catch(() => null);
    if (msg) this.pings.set(g.id, msg.message_id);
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
    const button: Keyboard = [[{ text: `🎲 Сесть за стол ${code}`, url: this.appLink(code) }]];
    const caption = `<b>${h(opener)} открыл стол ${h(code)}</b>\n\nСадись, раздаём карты!`;
    for (const m of members) {
      if (m.tgId !== openerTgId && m.status !== 'no') await this.dm(m.tgId, () => this.photo(m.tgId, 'table-open', caption, button)).catch(() => {});
    }
    if (g.chatId && g.chatId < 0) await this.photo(g.chatId, 'table-open', caption, button).catch(() => {});
    return true;
  }

  // ---------- Inline: карточки в любом чате ----------

  private inlinePhoto(id: string, image: string, title: string, description: string, caption: string, keyboard: Keyboard): any {
    const base = { id, title, description, caption, parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };
    const file = this.files.get(image);
    if (file) return { type: 'photo', photo_file_id: file, ...base };
    const url = this.imageUrl(image);
    if (url) return { type: 'photo', photo_url: url, thumbnail_url: url, ...base };
    return { type: 'article', id, title, description, input_message_content: { message_text: caption, parse_mode: 'HTML' }, reply_markup: { inline_keyboard: keyboard } };
  }

  private async onInline(q: any): Promise<void> {
    const query: string = (q.query ?? '').trim();
    const results: any[] = [];
    const table = /^(MAF-\d{4})(-s)?$/i.exec(query);
    const sbor = /^(?:сбор|g)\s*(\d+)$/i.exec(query);
    if (table) {
      const code = table[1].toUpperCase();
      const spectator = !!table[2];
      const info = this.opts.roomInfo?.(code) ?? null;
      const caption = `<b>${h(nameOf(q.from))} зовёт ${spectator ? 'посмотреть игру' : 'за стол'} ${code}</b>\n\nСпортивная мафия с котиками прямо в Telegram: 6-10 игроков, голос, карты с ролями.`
        + (info ? `\n\n🪑 За столом ${info.players}/${MAX}${info.host ? ` · 🎙 ведущий ${h(info.host)}` : ''}` : '');
      results.push(this.inlinePhoto(`t-${code}`, 'table-open', `Позвать за стол ${code}`, 'Карточка с кнопкой «Сесть за стол»', caption,
        [[{ text: spectator ? '👀 Смотреть игру' : '🎲 Сесть за стол', url: this.appLink(code + (spectator ? '-s' : '')) }]]));
    } else if (sbor) {
      const g = await this.store.getGathering(+sbor[1]);
      if (g && g.status === 'open') {
        const { image, caption, keyboard } = await this.card(g.id);
        results.push(this.inlinePhoto(`g-${g.id}`, image, 'Сбор на спортивную мафию', `${formatWhen(g.startsAt, g.tz, this.opts.now())} (${cityOf(g.tz)})`, caption, keyboard));
      }
    } else {
      const keyboard: Keyboard = [[{ text: '🎲 Играть', url: this.appLink() }], [{ text: '🎩 Знакомство с Доном', url: this.startLink('hi') }]];
      results.push(this.inlinePhoto('play', 'menu', 'Позвать в спортивную мафию', 'Карточка с кнопкой «Играть»',
        '<b>Сыграем в спортивную мафию?</b>\n\nОнлайн-стол с котиками прямо в Telegram: 6-10 игроков, голос, живой ведущий или игра без него.', keyboard));
      const j = jokeFor(Math.floor(Date.now() / 3_600_000), q.from.id);
      results.push(this.inlinePhoto('fraza', jokeImage(j), '🎭 Фраза Дона', j.text.slice(0, 80), jokeCaption(j), keyboard));
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
          const j = jokeFor(c.quoteSeq, c.chatId);
          const button: Button = c.kind === 'group' ? { text: '📅 Собрать игру', callback_data: 'm:sbor' } : { text: '🎲 Сыграть', url: this.appLink() };
          await this.photo(c.chatId, jokeImage(j), jokeCaption(j), [[button]]).catch(async (e) => {
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
    const when = `${whenTitle(g, now)} (${cityOf(g.tz)})`;
    const team = go.slice(0, MAX).map((m) => h(m.name)).join(', ');

    if (!g.reminded60 && t >= start - 60 * MIN && t < start) {
      await this.store.saveGathering({ ...g, reminded60: true });
      g.reminded60 = true;
      for (const [i, m] of go.entries()) {
        const spare = i >= MAX ? '\n\n🪑 Пока ты в запасе, но за столом всякое бывает.' : '';
        await this.dm(m.tgId, () => this.photo(m.tgId, 'remind-60', `<b>⏰ Через час мафия</b>\n📅 ${when}\n\n✅ Состав ${Math.min(go.length, MAX)}/${MAX}: ${team}${spare}`));
      }
      for (const m of maybe) {
        await this.dm(m.tgId, () => this.photo(m.tgId, 'remind-60', `<b>⏰ Через час мафия</b>\n📅 ${when}\n\nТы пока «может быть». Будешь?`,
          [[{ text: '✅ Буду', callback_data: `g:${g.id}:go` }, { text: '❌ Не смогу', callback_data: `g:${g.id}:no` }]]));
      }
    }
    if (!g.reminded10 && t >= start - 10 * MIN && t < start + 30 * MIN) {
      await this.store.saveGathering({ ...g, reminded10: true });
      const table: Keyboard | undefined = g.roomCode ? [[{ text: `🎲 Сесть за стол ${g.roomCode}`, url: this.appLink(g.roomCode) }]] : undefined;
      for (const m of go) {
        if (m.tgId === g.creatorTgId) continue;
        await this.dm(m.tgId, () => this.photo(m.tgId, 'remind-10', g.roomCode
          ? `<b>⏰ Через 10 минут начинаем</b>\n\n🎲 Стол уже открыт: <b>${h(g.roomCode)}</b>`
          : `<b>⏰ Через 10 минут начинаем</b>\n\nКак только ${h(g.creatorName)} откроет стол, пришлю кнопку сюда.`, table));
      }
      if (!g.roomCode) {
        await this.dm(g.creatorTgId, () => this.photo(g.creatorTgId, 'remind-10',
          `<b>⏰ Через 10 минут твой сбор</b>\n\n✅ Записались ${go.length}: ${team}\n\nОткрой стол, а я позову всех, кто записался.`,
          [[{ text: '🎲 Открыть стол для сбора', url: this.appLink(`G${g.id}`) }]]));
      }
      if (g.chatId && g.chatId < 0) {
        await this.photo(g.chatId, 'remind-10', `<b>⏰ Через 10 минут начинаем!</b>\n\n✅ Будут: ${team || 'пока никто'}`, table).catch(() => {});
      }
    }
  }
}

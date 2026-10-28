// Точка входа интерфейса: связь с сервером, отрисовка экранов и обработка нажатий.

import type { Action } from '../../engine/index.ts';
import type { ServerMessage } from '../../server/protocol.ts';
import { Net } from './net.ts';
import { save, store } from './store.ts';
import type { Store } from './store.ts';
import { clock, esc, isNightLike, outText, remainingMs } from './util.ts';
import { renderHost } from './views/host.ts';
import { renderLobby } from './views/lobby.ts';
import { renderHome } from './views/home.ts';
import { renderRules } from './views/rules.ts';
import { randomQuoteIndex } from './quotes.ts';
import { pickMode, renderPlay } from './views/play.ts';
import { markTalking, renderVoice } from './views/voice.ts';
import { VoiceClient } from './voice.ts';
import { api, haptic, inTelegram, miniAppInitData, mountLoginWidget, parseStartParam, setBackButton, setupMiniApp, shareInTelegram } from './tg.ts';
import type { GameView } from '../../engine/index.ts';
import type { Account } from './tg.ts';
import { renderProfile } from './views/profile.ts';
import { preloadCardArt } from './views/cards.ts';
import { seatArt } from './art.ts';
import { inGame, menuSheets } from './views/exit.ts';
import { chime, keepAwake } from './attention.ts';

const root = document.getElementById('app')!;
let explicitResume = false; // человек сам нажал «Вернуться в прежнюю игру»

// Ссылка на другой стол важнее запомненной игры: не возвращаем в старую комнату,
// а показываем вход в новую и кнопку «Вернуться в прежнюю игру»
if (store.session && store.code && store.code !== store.session.code) {
  store.prevSession = store.session;
  store.session = null;
}
const voiceRoot = document.getElementById('voice')!;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

function toast(text: string): void {
  store.toast = text;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    store.toast = null;
    render();
  }, 3500);
  render();
}

// ---------- Связь ----------

function onMessage(msg: ServerMessage): void {
  switch (msg.t) {
    case 'welcome':
      // Экран не трогаем: сразу следом придёт стол, и окно сменится лобби за один раз
      store.prevSession = null;
      store.session = { code: msg.code, token: msg.token };
      save('mafia.session', store.session);
      history.replaceState(null, '', '/');
      return;
    case 'state': {
      store.offset = msg.now - Date.now();
      const seat = msg.game?.mySeat;
      const dealtAt = seat ? msg.game!.seats[seat - 1]?.dealtAt ?? null : null;
      const prev = store.game?.mySeat ? store.game.seats[store.game.mySeat - 1]?.dealtAt ?? null : null;
      // Свою карту только что взяли: когда она перевернётся, обновим плашку с ролью
      if (msg.game?.phase === 'deal' && dealtAt !== null && dealtAt !== prev) setTimeout(render, 1600);
      feel(store.game, msg.game);
      if (!store.room) { store.sheet = null; store.screen = 'main'; }
      store.room = msg.room;
      store.game = msg.game;
      voice.update(msg.room);
      break;
    }
    case 'voice':
      void voice.connect(msg.url, msg.token);
      return;
    case 'error':
      if (msg.code === 'room_gone') {
        // Предупреждаем, только если человек сейчас был за столом или сам попросил вернуться.
        // При обычном входе в игру старый закрытый стол просто забываем.
        const wasHere = store.room !== null || explicitResume;
        explicitResume = false;
        forgetSession();
        store.code = '';
        if (!wasHere) return render();
      }
      if (store.sheet === 'join' && !store.room && /не найдена/i.test(msg.message)) {
        fieldError('code', 'Такого стола нет. Проверь код');
        return;
      }
      toast(msg.message);
      return;
    case 'closed':
      forgetSession();
      store.code = '';
      toast(msg.reason);
      return;
  }
  render();
}

/** Вибрация и, если включён, звук: твоя очередь или тебя выставили. */
function signal(kind: 'turn' | 'alert'): void {
  haptic(kind);
  if (store.sound) chime(kind);
}

/** Вибрация на важных для игрока моментах (в Telegram и на Android). */
function feel(prev: GameView | null, next: GameView | null): void {
  if (!next) return;
  const me = next.mySeat;
  const speech = (g: GameView | null) => !!g && ['day', 'tieSpeech', 'lastWord'].includes(g.phase) && g.speaker === me && me !== null;
  if (speech(next) && !(speech(prev) && prev!.phase === next.phase)) return signal('turn');
  if (next.phase === 'deal' && next.deal?.turn === me && prev?.deal?.turn !== me) return signal('turn');
  if (me && next.nominations.some((x) => x.target === me) && !prev?.nominations.some((x) => x.target === me)) return signal('alert');
  if (next.phase === 'voting' && prev?.phase !== 'voting') return haptic('tap');
  if (next.phase === 'night' && prev && (prev.phase !== 'night' || prev.nightStep !== next.nightStep) && pickMode(next)) return haptic('tap');
  if (next.phase === 'ended' && prev && prev.phase !== 'ended' && me) {
    const role = next.seats[me - 1]?.role;
    const black = role === 'mafia' || role === 'don';
    if (next.winner === 'draw') return haptic('tap');
    return haptic((next.winner === 'black') === black ? 'win' : 'lose');
  }
}

function forgetSession(): void {
  store.session = null;
  store.room = null;
  store.game = null;
  store.menu = false;
  store.confirm = null;
  voice.update(null);
  save('mafia.session', null);
}

const net = new Net(onMessage, (online) => {
  store.online = online;
  if (online) store.everConnected = true;
  render();
}, () => {
  if (store.session) net.send({ t: 'resume', code: store.session.code, token: store.session.token });
  else maybeAutoJoin();
});

// ---------- Аккаунт ----------

function setAccount(acc: Account | null): void {
  store.account = acc;
  if (!inTelegram) save('mafia.account', acc);
  if (acc && !store.nick.trim()) store.nick = acc.user.firstName.slice(0, 24);
}

/** Открыли приглашение в Telegram: садимся за стол сразу, как только есть связь и вход проверен. */
function maybeAutoJoin(): void {
  if (!store.autoJoin || store.authPending || !store.online || store.room || store.session) return;
  if (!store.code || !store.nick.trim()) return;
  store.autoJoin = false;
  net.send({ t: 'join', code: store.code, nick: store.nick, as: store.joinAs, session: store.account?.session, gender: store.gender });
}

async function loadProfile(): Promise<void> {
  const acc = store.account;
  if (!acc || store.profile.loading) return;
  store.profile = { stats: store.profile.stats, error: null, loading: true };
  render();
  try {
    const me = await api.me(acc.session);
    store.account = { ...acc, user: me.user };
    store.profile = { stats: me.stats, error: null, loading: false };
  } catch (e) {
    if ((e as { status?: number }).status === 401) {
      setAccount(null);
      store.screen = 'main';
      toast('Войди заново');
      return;
    }
    store.profile = { stats: null, error: (e as Error).message || 'Нет связи с сервером', loading: false };
  }
  render();
}

async function startAccount(): Promise<void> {
  setupMiniApp(render);
  try {
    store.config = await api.config();
  } catch {
    store.config = null;
  }
  if (inTelegram && miniAppInitData && store.config?.accounts) {
    try {
      const r = await api.authMiniApp(miniAppInitData);
      setAccount({ session: r.session, user: r.user });
      const invite = parseStartParam(r.startParam);
      if (invite && !store.room) store.code = invite.code;
    } catch (e) {
      console.warn('Вход через Telegram не прошёл', e);
    }
  }
  store.authPending = false;
  render();
  maybeAutoJoin();
  // Статистика для главного экрана
  if (store.account) void loadProfile();
}

// Голос перерисовывает только свою плашку и подсветку мест: он меняется часто
const voice = new VoiceClient((msg) => net.send(msg), () => renderVoiceBar());

function renderVoiceBar(): void {
  const html = renderVoice(store.room, store.game, voice.state, voice.canSpeak);
  if (voiceRoot.innerHTML !== html) voiceRoot.innerHTML = html;
  document.body.classList.toggle('has-voice', html !== '');
  layoutBars();
  markTalking(root, store.room, voice.state.talking);
}

function act(action: Action): void {
  net.send({ t: 'act', action });
}

// ---------- Отрисовка ----------

function selectionKey(): string {
  const g = store.game;
  return g ? [g.phase, g.day, g.night, g.nightStep, g.speaker].join('|') : '';
}

let preloaded = '';
window.addEventListener('resize', () => layoutBars());
let shownSheet: string | null = null;

/** Какое нижнее окно сейчас открыто: от этого зависит, выезжает ли оно заново. */
function sheetKey(): string | null {
  if (store.sheet) return store.sheet;
  if (store.hostSeat) return `seat${store.hostSeat}`;
  if (store.confirm) return `confirm-${store.confirm}`;
  if (store.menu) return 'menu';
  return null;
}
let shownBar = '';
let shownScreen = '';
let wasNight: boolean | null = null;
let memoPhase = '';

/** Заставка на полторы секунды при смене дня и ночи. При «меньше движения» только плавно меняется фон. */
function dusk(night: boolean): void {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  document.querySelector('.dusk')?.remove();
  const el = document.createElement('div');
  el.className = `dusk ${night ? 'to-night' : 'to-day'}`;
  el.setAttribute('role', 'status');
  el.innerHTML = `${CAT}<b>${night ? 'Город засыпает' : 'Город просыпается'}</b>`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1500);
}

// Силуэт кота для заставки ночи
const CAT = '<svg viewBox="0 0 64 64" width="84" height="84" fill="currentColor" aria-hidden="true"><path d="M14 8l9 11a18 18 0 0 1 18 0l9-11 2 20a20 20 0 0 1-3 13c5 4 8 10 8 17v2H11v-2c0-7 3-13 8-17a20 20 0 0 1-3-13z"/></svg>';

/** Высоты нижних плашек (голос и панель действия) в CSS: панель встаёт над голосом, контент не прячется под ними. */
function layoutBars(): void {
  const v = voiceRoot.firstElementChild as HTMLElement | null;
  const bar = root.querySelector<HTMLElement>('.action-bar');
  const style = document.body.style;
  style.setProperty('--voice-off', v ? `${v.offsetHeight + 8}px` : '0px');
  style.setProperty('--bar-h', bar ? `${bar.offsetHeight}px` : '0px');
}

function render(): void {
  // Новый шаг игры — сбрасываем выбранные номера
  const key = selectionKey();
  if (key !== store.selectKey) {
    store.selectKey = key;
    store.selected = [];
  }
  if (store.game?.phase !== 'deal') store.cardHidden = false;
  // Записка семьи сворачивается сама при смене фазы
  const phaseKey = store.game ? `${store.game.phase}|${store.game.day}|${store.game.night}` : '';
  if (phaseKey !== memoPhase) { memoPhase = phaseKey; store.memoOpen = false; }
  // Перед раздачей заранее грузим своего мирного кота: карта перевернётся уже с картинкой
  const meNow = store.room?.members.find((m) => m.id === store.room?.you.id);
  if (meNow?.art != null && meNow.seat) {
    const art = seatArt('civilian', meNow.seat, store.room?.members);
    if (art !== preloaded) { preloaded = art; preloadCardArt([art]); }
  }

  const room = store.room;
  const game = store.game;
  let html: string;
  if (!room && store.screen === 'profile' && store.account) html = renderProfile(store);
  else if (store.screen === 'rules') html = renderRules();
  else if (!room) html = renderHome(store);
  else if (!game) html = renderLobby(store);
  else if (room.you.kind === 'host') html = renderHost(store);
  else html = renderPlay(store);

  if (room && store.screen !== 'rules') html += menuSheets(store);
  if (store.toast) html += `<div class="toast" role="alert">${store.toast.replace(/</g, '&lt;')}</div>`;
  if (!store.online && store.everConnected) html += '<div class="offline" role="status">Нет связи с сервером, переподключаемся…</div>';

  // Сохраняем фокус в поле ввода, если экран перерисовался во время набора
  const focused = document.activeElement as HTMLInputElement | null;
  const focusModel = focused?.dataset?.model;
  const caret = focused?.selectionStart ?? null;

  // Окно на главном экране выезжает только при открытии, а не при каждой перерисовке
  const openSheet = sheetKey();
  const sheetEnter = openSheet !== null && openSheet !== shownSheet;
  shownSheet = openSheet;
  const sheetScroll = root.querySelector('.sheet')?.scrollTop ?? 0;

  const night = isNightLike(game) && room?.you.kind !== 'host';
  if (game && game.phase !== 'ended' && wasNight !== null && night !== wasNight) dusk(night);
  wasNight = game ? night : null;
  document.body.classList.toggle('is-night', night);
  root.innerHTML = html;
  // Сменился экран (главный, лобби, партия, финал): начинаем сверху, а не с прокрутки прошлого экрана
  const screenId = store.screen === 'rules' ? 'rules' : !room ? `home-${store.screen}` : !game ? 'lobby' : game.phase === 'ended' ? 'final' : 'game';
  if (screenId !== shownScreen) {
    if (shownScreen !== '') window.scrollTo(0, 0);
    shownScreen = screenId;
  }

  const sheetEl = root.querySelector('.sheet');
  if (sheetEl) {
    if (sheetEnter) {
      sheetEl.classList.add('enter');
      root.querySelector('.sheet-backdrop')?.classList.add('enter');
    } else sheetEl.scrollTop = sheetScroll;
  }

  renderVoiceBar();

  // Панель действия выезжает, только когда появился новый шаг, а не при каждой перерисовке
  const barEl = root.querySelector<HTMLElement>('.action-bar');
  const barKey = barEl?.querySelector('.ab-head b')?.textContent ?? '';
  if (barEl && barKey !== shownBar) barEl.classList.add('enter');
  shownBar = barKey;
  layoutBars();
  // Пока идёт партия, экран телефона не гаснет (игрок или ведущий; зрителю не нужно)
  keepAwake(!!game && game.phase !== 'ended' && room?.you.kind !== 'spectator');

  // Системная кнопка «Назад» в Telegram: закрыть окно, выйти из профиля или правил
  if (sheetKey()) setBackButton(() => handlers.sheetClose(root));
  else if (store.screen !== 'main' && (store.screen === 'rules' || !room)) setBackButton(() => { store.screen = 'main'; render(); window.scrollTo(0, 0); });
  else if (room && inGame(store)) setBackButton(() => handlers.askLeave(root)); // «Назад» посреди партии спрашивает, точно ли выйти
  else setBackButton(null);

  // Кнопка «Войти через Telegram» на сайте
  const login = root.querySelector<HTMLElement>('#tg-login');
  const bot = store.config?.telegram?.bot;
  if (login && bot) {
    mountLoginWidget(login, bot, (user) => {
      api.authWidget(user)
        .then((acc) => {
          setAccount({ session: acc.session, user: acc.user });
          toast(`${store.gender === 'f' ? 'Ты вошла' : 'Ты вошёл'} как ${acc.user.firstName}`);
        })
        .catch((e: Error) => toast(e.message));
    });
  }

  if (focusModel) {
    const input = root.querySelector<HTMLInputElement>(`[data-model="${focusModel}"]`);
    if (input) {
      input.focus();
      if (caret !== null) input.setSelectionRange(caret, caret);
    }
  }
}

// Таймеры тикают без перерисовки всего экрана
setInterval(() => {
  const game = store.game;
  if (!game) return;
  const left = remainingMs(game, store.offset);
  if (left === null) return;
  for (const el of root.querySelectorAll<HTMLElement>('[data-clock]')) el.textContent = clock(left);
}, 250);

// ---------- Нажатия ----------

/** Подсветить поле в окне входа красным и написать под ним, что не так. */
function fieldError(field: 'nick' | 'code', text: string): void {
  store.fieldError = { ...store.fieldError, [field]: text };
  haptic('alert');
  render();
  const input = root.querySelector<HTMLInputElement>(`#${field}`);
  input?.focus();
  input?.closest('.field')?.classList.remove('shake');
  void input?.offsetWidth; // перезапуск анимации, если ошибка повторилась
  input?.closest('.field')?.classList.add('shake');
}

/** Переключатель из нескольких кнопок: отмечаем нажатую на месте, без перерисовки экрана. */
function pressOnly(el: HTMLElement): void {
  el.parentElement?.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === el)));
}

function num(el: HTMLElement): number {
  return Number(el.dataset.n);
}

const handlers: Record<string, (el: HTMLElement) => void> = {
  gender: (el) => {
    const v = el.dataset.v;
    store.gender = v === 'f' || v === 'x' ? v : 'm';
    save('mafia.gender', store.gender);
    pressOnly(el);
  },
  joinAs: (el) => { store.joinAs = el.dataset.v === 'spectator' ? 'spectator' : 'player'; pressOnly(el); },
  create: (el) => {
    if (!store.nick.trim()) return fieldError('nick', 'Введи ник, чтобы сесть за стол');
    net.send({ t: 'create', nick: store.nick, as: el.dataset.v === 'player' ? 'player' : 'host', session: store.account?.session, gender: store.gender });
  },
  restart: () => net.send({ t: 'restart' }),
  card: (el) => act({ type: 'pickCard', index: num(el) }),
  flipCard: () => { store.cardHidden = !store.cardHidden; render(); },
  join: () => {
    const nickMissing = !store.nick.trim();
    const codeMissing = !store.code.trim();
    if (nickMissing || codeMissing) {
      store.fieldError = {};
      if (codeMissing) fieldError('code', 'Введи код стола, например MAF-4821');
      if (nickMissing) fieldError('nick', 'Введи ник, чтобы сесть за стол');
      return;
    }
    net.send({ t: 'join', code: store.code.trim().toUpperCase(), nick: store.nick, as: store.joinAs, session: store.account?.session, gender: store.gender });
  },
  copyLink: async (el) => {
    const link = el.dataset.v ?? '';
    try {
      await navigator.clipboard.writeText(link);
      toast('Ссылка скопирована');
    } catch {
      toast(link);
    }
  },
  invite: (el) => {
    const link = el.dataset.v ?? '';
    if (inTelegram && shareInTelegram(link, 'Садись за стол: спортивная мафия')) return;
    handlers.copyLink(el);
  },
  profile: () => {
    store.screen = 'profile';
    store.sheet = null;
    render();
    window.scrollTo(0, 0);
    void loadProfile();
  },
  profileBack: () => { store.screen = 'main'; render(); },
  sheet: (el) => {
    store.sheet = el.dataset.v === 'join' ? 'join' : 'create';
    store.fieldError = {};
    render();
    // На телефоне сразу открываем клавиатуру там, где нужно ввести
    const input = root.querySelector<HTMLInputElement>(store.sheet === 'join' && store.nick.trim() ? '#code' : '#nick');
    if (input && !(store.sheet === 'join' && store.code)) input.focus();
  },
  sheetClose: () => {
    store.sheet = null;
    store.fieldError = {};
    store.hostSeat = null;
    store.removeArmed = null;
    store.ppkArmed = null;
    store.menu = false;
    store.confirm = null;
    render();
  },
  nextQuote: () => { store.quote = randomQuoteIndex(store.quote); render(); },
  rules: () => { store.screen = 'rules'; store.sheet = null; store.menu = false; render(); window.scrollTo(0, 0); },
  rulesBack: () => { store.screen = 'main'; render(); window.scrollTo(0, 0); },
  logout: () => {
    setAccount(null);
    store.screen = 'main';
    store.profile = { stats: null, error: null, loading: false };
    render();
  },
  addBots: () => net.send({ t: 'addBots' }),
  start: () => net.send({ t: 'start' }),
  // Меню стола и подтверждения
  menu: () => { store.menu = true; store.confirm = null; render(); },
  askLeave: () => { store.menu = false; store.confirm = 'leave'; render(); },
  askDisband: () => { store.menu = false; store.confirm = 'disband'; render(); },
  soundToggle: (el) => {
    store.sound = !store.sound;
    save('mafia.sound', store.sound);
    el.setAttribute('aria-pressed', String(store.sound));
  },
  disband: () => {
    store.confirm = null;
    net.send({ t: 'disband' });
    render();
  },
  backToPrev: () => {
    const prev = store.prevSession;
    if (!prev) return;
    store.prevSession = null;
    store.session = prev;
    store.code = '';
    explicitResume = true;
    net.send({ t: 'resume', code: prev.code, token: prev.token });
    render();
  },
  leave: () => {
    store.menu = false;
    store.confirm = null;
    net.send({ t: 'leave' });
    forgetSession();
    store.code = '';
    render();
  },
  memo: () => { store.memoOpen = !store.memoOpen; render(); },
  toggleLog: () => { store.showLog = !store.showLog; render(); },

  // Выбор номеров за столом
  seat: (el) => {
    // Ведущий: нажатие на место открывает окно с фолами и удалением
    if (store.room?.you.kind === 'host' && store.game) {
      store.hostSeat = num(el);
      store.removeArmed = null;
      store.ppkArmed = null;
      return render();
    }
    const game = store.game;
    const mode = game && pickMode(game);
    const n = num(el);
    if (!game || !mode || !mode.allow(n)) return;
    if (mode.kind === 'plan') {
      const plan = [...(game.mafia?.plan ?? [])];
      const at = plan.indexOf(n);
      if (at >= 0) plan.splice(at, 1);
      else if (plan.length < mode.max) plan.push(n);
      return act({ type: 'setPlan', plan });
    }
    const sel = store.selected;
    if (sel.includes(n)) store.selected = sel.filter((x) => x !== n);
    else store.selected = mode.max === 1 ? [n] : sel.length < mode.max ? [...sel, n] : sel;
    render();
  },
  confirm: () => {
    const game = store.game;
    const mode = game && pickMode(game);
    const sel = store.selected;
    if (!mode || !sel.length) return;
    if (mode.kind === 'nominate') act({ type: 'nominate', target: sel[0] });
    if (mode.kind === 'shoot') act({ type: 'shoot', target: sel[0] });
    if (mode.kind === 'check') act({ type: 'check', target: sel[0] });
    if (mode.kind === 'bestMove') act({ type: 'bestMove', seats: sel });
    store.selected = [];
  },
  planReset: () => act({ type: 'setPlan', plan: [] }),
  beacon: (el) => act({ type: 'setBeacon', beacon: num(el) as 0 | 1 | 2 | 3 }),
  phrase: (el) => act({ type: 'setPhrase', index: num(el) }),
  pass: () => act({ type: 'pass' }),
  vote: (el) => act({ type: 'vote', target: num(el) }),
  liftYes: () => act({ type: 'liftYes' }),

  // Ведущий
  next: () => act({ type: 'next' }),
  pause: () => act({ type: 'pause' }),
  resume: () => act({ type: 'resume' }),
  add30: () => act({ type: 'addTime', ms: 30_000 }),
  foul: (el) => act({ type: 'foul', seat: num(el), delta: 1 }),
  unfoul: (el) => act({ type: 'foul', seat: num(el), delta: -1 }),
  remove: (el) => {
    const n = num(el);
    if (store.removeArmed === n) {
      store.removeArmed = null;
      store.hostSeat = null;
      act({ type: 'remove', seat: n });
      return render();
    }
    store.removeArmed = n;
    store.ppkArmed = null;
    render();
  },
  ppk: (el) => {
    const n = num(el);
    if (store.ppkArmed === n) {
      store.ppkArmed = null;
      store.hostSeat = null;
      act({ type: 'ppk', seat: n });
      return render();
    }
    store.ppkArmed = n;
    store.removeArmed = null;
    render();
  },
  tab: (el) => { store.hostTab = el.dataset.v as typeof store.hostTab; render(); },

  // Голос
  voiceOn: () => { void voice.start(); },
  voiceOff: () => { void voice.stop(); },
  voiceMute: () => voice.toggleMute(),
  voiceTap: () => { void voice.unlockAudio(); },
};

// ---------- Долгое нажатие на место: полный ник, фолы, кто выставил ----------

let pressTimer: ReturnType<typeof setTimeout> | null = null;
let longPressed = false;

function hideTip(): void {
  document.querySelector('.seat-tip')?.remove();
}

function showTip(seatEl: HTMLElement): void {
  const game = store.game;
  const n = Number(seatEl.dataset.n);
  const s = game?.seats[n - 1];
  if (!game || !s) return;
  const lines: string[] = [];
  if (!s.alive) lines.push(outText(s));
  lines.push(s.fouls ? `фолов ${s.fouls} из 4` : 'без фолов');
  const by = game.nominations.find((x) => x.target === n);
  if (by && ['day', 'voting', 'tieSpeech'].includes(game.phase)) lines.push(`выставил №${by.by}`);
  const m = store.room?.members.find((x) => x.seat === n);
  if (m && !m.connected) lines.push('не в сети');
  hideTip();
  const tip = document.createElement('div');
  tip.className = 'seat-tip';
  tip.innerHTML = `<b>№${n} ${esc(s.nick)}</b>${lines.join('<br>')}`;
  document.body.appendChild(tip);
  const r = seatEl.getBoundingClientRect();
  const left = Math.min(Math.max(8, r.left + r.width / 2 - tip.offsetWidth / 2), innerWidth - tip.offsetWidth - 8);
  const top = r.top - tip.offsetHeight - 8 > 8 ? r.top - tip.offsetHeight - 8 : r.bottom + 8;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
  haptic('tap');
}

root.addEventListener('pointerdown', (e) => {
  const seatEl = (e.target as HTMLElement).closest<HTMLElement>('.seat');
  longPressed = false;
  if (!seatEl) return;
  pressTimer = setTimeout(() => { longPressed = true; showTip(seatEl); }, 450);
});
for (const ev of ['pointerup', 'pointercancel', 'pointerleave'] as const) {
  root.addEventListener(ev, () => {
    if (pressTimer) clearTimeout(pressTimer);
    pressTimer = null;
    if (longPressed) setTimeout(hideTip, 1600);
  });
}
root.addEventListener('contextmenu', (e) => { if ((e.target as HTMLElement).closest('.seat')) e.preventDefault(); });
window.addEventListener('scroll', hideTip, { passive: true });

root.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (!el || (el as HTMLButtonElement).disabled) return;
  // После долгого нажатия место не выбираем: человек просто смотрел подсказку
  if (longPressed && el.classList.contains('seat')) { longPressed = false; return; }
  const name = el.dataset.act!;
  // Подтверждение удаления, ППК и роспуска стола сбрасывается любым другим нажатием
  if (name !== 'remove' && name !== 'ppk' && (store.removeArmed !== null || store.ppkArmed !== null)) {
    store.removeArmed = null;
    store.ppkArmed = null;
    render();
  }
  handlers[name]?.(el);
});

voiceRoot.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (el && !(el as HTMLButtonElement).disabled) handlers[el.dataset.act!]?.(el);
});

root.addEventListener('input', (e) => {
  const input = e.target as HTMLInputElement;
  const model = input.dataset.model;
  // Начал печатать: убираем красную подсказку на месте, без перерисовки
  if ((model === 'nick' || model === 'code') && store.fieldError[model]) {
    delete store.fieldError[model];
    const field = input.closest('.field');
    field?.classList.remove('invalid', 'shake');
    field?.querySelector('.field-error')?.remove();
  }
  if (model === 'nick') {
    store.nick = input.value;
    save('mafia.nick', input.value.trim());
  }
  if (model === 'code') store.code = input.value.toUpperCase();
});

root.addEventListener('keydown', (e) => {
  const input = e.target as HTMLElement;
  if (e.key === 'Enter' && input.dataset?.model && store.sheet === 'join') handlers.join(input);
  if ((e.key === 'Enter' || e.key === ' ') && input.dataset?.act === 'flipCard') {
    e.preventDefault();
    handlers.flipCard(input);
  }
});

render();
net.connect();
void startAccount();
preloadCardArt();

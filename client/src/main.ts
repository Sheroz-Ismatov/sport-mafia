// Точка входа интерфейса: связь с сервером, отрисовка экранов и обработка нажатий.

import type { Action } from '../../engine/index.ts';
import type { ServerMessage } from '../../server/protocol.ts';
import { Net } from './net.ts';
import { save, store } from './store.ts';
import { clock, isNightLike, remainingMs } from './util.ts';
import { renderHost } from './views/host.ts';
import { renderHome, renderLobby } from './views/lobby.ts';
import { pickMode, renderPlay } from './views/play.ts';

const root = document.getElementById('app')!;
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
      store.session = { code: msg.code, token: msg.token };
      save('mafia.session', store.session);
      history.replaceState(null, '', '/');
      break;
    case 'state': {
      store.offset = msg.now - Date.now();
      const seat = msg.game?.mySeat;
      const dealtAt = seat ? msg.game!.seats[seat - 1]?.dealtAt ?? null : null;
      const prev = store.game?.mySeat ? store.game.seats[store.game.mySeat - 1]?.dealtAt ?? null : null;
      // Свою карту только что взяли: когда она перевернётся, обновим плашку с ролью
      if (msg.game?.phase === 'deal' && dealtAt !== null && dealtAt !== prev) setTimeout(render, 1600);
      store.room = msg.room;
      store.game = msg.game;
      break;
    }
    case 'error':
      if (msg.message.includes('вернуться')) forgetSession();
      toast(msg.message);
      return;
    case 'closed':
      forgetSession();
      toast(msg.reason);
      return;
  }
  render();
}

function forgetSession(): void {
  store.session = null;
  store.room = null;
  store.game = null;
  save('mafia.session', null);
}

const net = new Net(onMessage, (online) => {
  store.online = online;
  if (online) store.everConnected = true;
  render();
}, () => {
  if (store.session) net.send({ t: 'resume', code: store.session.code, token: store.session.token });
});

function act(action: Action): void {
  net.send({ t: 'act', action });
}

// ---------- Отрисовка ----------

function selectionKey(): string {
  const g = store.game;
  return g ? [g.phase, g.day, g.night, g.nightStep, g.speaker].join('|') : '';
}

function render(): void {
  // Новый шаг игры — сбрасываем выбранные номера
  const key = selectionKey();
  if (key !== store.selectKey) {
    store.selectKey = key;
    store.selected = [];
  }
  if (store.game?.phase !== 'deal') store.cardHidden = false;

  const room = store.room;
  const game = store.game;
  let html: string;
  if (!room) html = renderHome(store);
  else if (!game) html = renderLobby(store);
  else if (room.you.kind === 'host') html = renderHost(store);
  else html = renderPlay(store);

  if (store.toast) html += `<div class="toast" role="alert">${store.toast.replace(/</g, '&lt;')}</div>`;
  if (!store.online && store.everConnected) html += '<div class="offline" role="status">Нет связи с сервером, переподключаемся…</div>';

  // Сохраняем фокус в поле ввода, если экран перерисовался во время набора
  const focused = document.activeElement as HTMLInputElement | null;
  const focusModel = focused?.dataset?.model;
  const caret = focused?.selectionStart ?? null;

  document.body.classList.toggle('is-night', isNightLike(game) && room?.you.kind !== 'host');
  root.innerHTML = html;

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

function num(el: HTMLElement): number {
  return Number(el.dataset.n);
}

const handlers: Record<string, (el: HTMLElement) => void> = {
  joinAs: (el) => { store.joinAs = el.dataset.v === 'spectator' ? 'spectator' : 'player'; render(); },
  create: (el) => {
    if (!store.nick.trim()) return toast('Введите ник');
    net.send({ t: 'create', nick: store.nick, as: el.dataset.v === 'player' ? 'player' : 'host' });
  },
  restart: () => net.send({ t: 'restart' }),
  card: (el) => act({ type: 'pickCard', index: num(el) }),
  flipCard: () => { store.cardHidden = !store.cardHidden; render(); },
  join: () => {
    if (!store.nick.trim()) return toast('Введите ник');
    if (!store.code.trim()) return toast('Введите код комнаты');
    net.send({ t: 'join', code: store.code.trim().toUpperCase(), nick: store.nick, as: store.joinAs });
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
  addBots: () => net.send({ t: 'addBots' }),
  start: () => net.send({ t: 'start' }),
  leave: () => {
    net.send({ t: 'leave' });
    forgetSession();
    store.code = '';
    render();
  },
  toggleLog: () => { store.showLog = !store.showLog; render(); },

  // Выбор номеров за столом
  seat: (el) => {
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
      return act({ type: 'remove', seat: n });
    }
    store.removeArmed = n;
    store.ppkArmed = null;
    render();
  },
  ppk: (el) => {
    const n = num(el);
    if (store.ppkArmed === n) {
      store.ppkArmed = null;
      return act({ type: 'ppk', seat: n });
    }
    store.ppkArmed = n;
    store.removeArmed = null;
    render();
  },
  tab: (el) => { store.hostTab = el.dataset.v as typeof store.hostTab; render(); },
};

root.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (!el || (el as HTMLButtonElement).disabled) return;
  const name = el.dataset.act!;
  // Подтверждение удаления и ППК сбрасывается любым другим нажатием
  if (name !== 'remove' && name !== 'ppk' && (store.removeArmed !== null || store.ppkArmed !== null)) {
    store.removeArmed = null;
    store.ppkArmed = null;
    render();
  }
  handlers[name]?.(el);
});

root.addEventListener('input', (e) => {
  const input = e.target as HTMLInputElement;
  const model = input.dataset.model;
  if (model === 'nick') {
    store.nick = input.value;
    save('mafia.nick', input.value.trim());
  }
  if (model === 'code') store.code = input.value.toUpperCase();
});

root.addEventListener('keydown', (e) => {
  const input = e.target as HTMLElement;
  if (e.key === 'Enter' && input.dataset?.model) handlers[store.code ? 'join' : 'create']?.(input);
  if ((e.key === 'Enter' || e.key === ' ') && input.dataset?.act === 'flipCard') {
    e.preventDefault();
    handlers.flipCard(input);
  }
});

render();
net.connect();

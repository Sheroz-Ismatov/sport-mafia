// Экран игрока, выбывшего и наблюдателя (телефон).

import type { GameView } from '../../../engine/index.ts';
import type { Store } from '../store.ts';
import { ROLE_NAME, esc, isBlackRole, outText, phaseTitle, NIGHT_STEP, winnerText } from '../util.ts';
import { renderTable } from './table.ts';
import { cardBack, flippingCard } from './cards.ts';

export type PickKind = 'plan' | 'nominate' | 'shoot' | 'check' | 'bestMove';

export interface PickMode {
  kind: PickKind;
  max: number;
  allow: (n: number) => boolean;
}

/** Можно ли сейчас выбирать номера за столом и зачем. */
export function pickMode(game: GameView): PickMode | null {
  const me = game.me;
  if (!me || !me.alive || game.phase === 'ended') return null;
  const alive = (n: number) => game.seats[n - 1]?.alive ?? false;
  const known = (n: number) => game.seats[n - 1]?.role ?? null;

  if (game.phase === 'zeroNight' && me.role === 'don') {
    return { kind: 'plan', max: 4, allow: (n) => !isBlackRole(known(n)) };
  }
  if (game.phase === 'day' && game.speaker === me.seat && !game.nominations.some((x) => x.by === me.seat)) {
    return { kind: 'nominate', max: 1, allow: (n) => alive(n) && !game.nominations.some((x) => x.target === n) };
  }
  if (game.phase === 'night') {
    if (game.nightStep === 'shoot' && me.team === 'black' && game.myShot === null) {
      return { kind: 'shoot', max: 1, allow: alive };
    }
    const checked = game.myChecks.some((c) => c.night === game.night);
    if (!checked && ((game.nightStep === 'don' && me.role === 'don') || (game.nightStep === 'sheriff' && me.role === 'sheriff'))) {
      return { kind: 'check', max: 1, allow: (n) => n !== me.seat };
    }
    if (game.nightStep === 'bestMove' && game.bestMoveBy === me.seat && !game.bestMove) {
      return { kind: 'bestMove', max: game.bestMoveSize, allow: (n) => n !== me.seat };
    }
  }
  return null;
}

function header(store: Store, game: GameView): string {
  const room = store.room!;
  let badge = '';
  // Пока своя карта переворачивается, плашка не подсказывает роль раньше времени
  const myDealtAt = game.mySeat ? game.seats[game.mySeat - 1]?.dealtAt ?? null : null;
  const flipping = game.phase === 'deal' && myDealtAt !== null && Date.now() + store.offset - myDealtAt < 1500;
  if (game.me && !flipping) {
    const role = game.me.role;
    badge = `<div class="badge"><div class="mini r-${role}">${game.me.seat}</div>
      <div class="bt"><small>${game.me.alive ? 'Ваша карта' : 'Вы выбыли'}</small><b class="t-${role}">${ROLE_NAME[role]}</b></div></div>`;
  } else if (game.mySeat) {
    badge = `<div class="badge"><div class="mini r-none">${game.mySeat}</div>
      <div class="bt"><small>Ваше место</small><b>${flipping ? 'Смотрите карту' : 'Карта не выбрана'}</b></div></div>`;
  } else {
    badge = `<div class="badge"><div class="mini r-none"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg></div>
      <div class="bt"><small>Наблюдатель</small><b>${room.spectators} в зале</b></div></div>`;
  }
  return `<div class="top"><div class="top-left"><span class="eyebrow">Комната ${esc(room.code)}</span>
    <h1>${phaseTitle(game)}</h1></div>${badge}</div>`;
}

function selectionButton(store: Store, mode: PickMode): string {
  const sel = store.selected;
  const list = sel.map((n) => '№' + n).join(', ');
  switch (mode.kind) {
    case 'nominate':
      return sel.length
        ? `<button class="btn red" data-act="confirm">Выставить ${list}</button>`
        : '<p class="hint">Чтобы выставить игрока, нажмите его номер за столом</p>';
    case 'shoot':
      return sel.length
        ? `<button class="btn red" data-act="confirm">Выстрелить в ${list}</button>`
        : '<p class="hint">Выберите номер за столом</p>';
    case 'check':
      return sel.length
        ? `<button class="btn primary" data-act="confirm">Проверить ${list}</button>`
        : '<p class="hint">Выберите, кого проверить</p>';
    case 'bestMove':
      return `<p class="hint">Выберите, кого считаете чёрными: ${sel.length} из ${mode.max}</p>
        <button class="btn gold" data-act="confirm" ${sel.length ? '' : 'disabled'}>Отправить лучший ход${sel.length ? ': ' + sel.join(', ') : ''}</button>`;
    default:
      return '';
  }
}

function mafiaMemo(game: GameView, compact: boolean): string {
  const m = game.mafia;
  if (!m) return '';
  const members = m.members.map((x) => `№${x.seat} ${x.role === 'don' ? 'дон' : 'мафия'}`).join(', ');
  const beacon = m.beacon ? `первый номер в речи дона +${m.beacon}` : 'без маяка';
  const plan = m.plan.length ? m.plan.map((n, i) => `Н${i + 1} №${n}`).join(' · ') : 'не задан';
  return `<div class="card gold">
    <div class="row"><span class="k">Чёрные</span><span class="v">${members}</span></div>
    ${compact ? '' : `<div class="row"><span class="k">План</span><span class="v">${plan}</span></div>`}
    ${m.planTargetTonight ? `<div class="row"><span class="k">По плану ${game.phase === 'night' ? 'сейчас' : 'ночью'}</span><span class="v">№${m.planTargetTonight}</span></div>` : ''}
    <div class="row"><span class="k">Маяк</span><span class="v">${beacon}</span></div>
    <div class="row"><span class="k">Шериф</span><span class="v">«${esc(m.sheriffPhrase)}»</span></div>
  </div>`;
}

function dogovorka(store: Store, game: GameView): string {
  const m = game.mafia;
  if (!m) {
    return `<div class="card"><h2>Город спит</h2><p class="note">Мафия знакомится и договаривается. Через минуту начнётся первый день.</p></div>`;
  }
  const isDon = game.me?.role === 'don';
  const plan = [0, 1, 2, 3].map((i) => {
    const n = m.plan[i];
    return `<div class="${n ? 'set' : ''}"><small>Ночь ${i + 1}</small><b>${n ? '№' + n : '—'}</b></div>`;
  }).join('');
  const beacons = [1, 2, 3, 0].map((b) => isDon
    ? `<button class="btn small ${m.beacon === b ? 'on' : ''}" data-act="beacon" data-n="${b}" aria-pressed="${m.beacon === b}">${b ? '+' + b : 'Без маяка'}</button>`
    : '').join('');
  const phrases = m.phrases.map((p, i) => isDon
    ? `<button class="radio" data-act="phrase" data-n="${i}" aria-pressed="${p === m.sheriffPhrase}"><span class="dot"></span>«${esc(p)}»</button>`
    : '').join('');
  const members = m.members.map((x) => `№${x.seat} ${x.role === 'don' ? 'дон' : 'мафия'}`).join(', ');
  return `<div class="card gold"><div class="row"><span class="k">Ваша команда</span><span class="v">${members}</span></div></div>
    <div class="stack">
      <div class="row"><h2>План отстрела</h2>${isDon && m.plan.length ? '<button class="link" data-act="planReset">Сбросить</button>' : ''}</div>
      <div class="plan">${plan}</div>
      <p class="hint">${isDon ? 'Нажимайте номера за столом по порядку ночей' : 'План задаёт дон, вы видите его вживую'}</p>
    </div>
    <div class="stack"><h2>Маяк: первый номер в речи дона</h2>
      ${isDon ? `<div class="grid4">${beacons}</div>` : `<p class="note">${m.beacon ? '+' + m.beacon : 'Без маяка'}</p>`}</div>
    <div class="stack"><h2>Фраза «нашёл шерифа»</h2>
      ${isDon ? phrases : `<p class="note">«${esc(m.sheriffPhrase)}»</p>`}</div>`;
}

function dealPanel(store: Store, game: GameView): string {
  const d = game.deal!;
  const now = Date.now() + store.offset;
  const me = game.me;
  const myTurn = game.mySeat !== null && d.turn === game.mySeat && !me;
  const parts: string[] = [];

  if (me) {
    const dealtAt = game.seats[me.seat - 1].dealtAt ?? now;
    parts.push(`<div class="card gold reveal">
      <h2>Ваша карта</h2>
      <div data-act="flipCard" role="button" tabindex="0" aria-label="${store.cardHidden ? 'Показать карту' : 'Скрыть карту'}">${flippingCard(me.role, now - dealtAt, store.cardHidden)}</div>
      <p class="note">${store.cardHidden ? 'Карта перевёрнута. Нажмите, чтобы посмотреть ещё раз.' : `Вы ${ROLE_NAME[me.role].toLowerCase()}. Роль видите только вы, запомните её.`}</p>
    </div>`);
  }

  // Колода: взятые карты улетают и оставляют пустое место
  const slots = d.takenBy.map((by, i) => {
    if (by === null) {
      return `<button class="deck-slot" data-act="card" data-n="${i}" ${myTurn ? '' : 'disabled'} aria-label="Карта ${i + 1}">${cardBack()}</button>`;
    }
    const at = game.seats[by - 1]?.dealtAt ?? 0;
    const elapsed = now - at;
    return elapsed < 600
      ? `<div class="deck-slot leaving" style="animation-delay:${-elapsed}ms">${cardBack()}</div>`
      : '<div class="deck-slot empty"></div>';
  }).join('');

  let hint: string;
  if (myTurn) hint = '<b>Ваша очередь:</b> возьмите любую карту из колоды';
  else if (me) hint = 'Остальные тянут свои карты';
  else if (game.mySeat && d.turn !== null) {
    const left = game.mySeat - d.turn;
    hint = `Тянет №${d.turn}. Ваша очередь через ${left} ${left === 1 ? 'игрока' : left < 5 ? 'игрока' : 'игроков'}`;
  } else hint = `Тянет карту №${d.turn}`;

  parts.push(`<div class="card${myTurn ? ' gold' : ''}">
    <div class="row"><h2>Колода</h2><span class="hint">${d.takenBy.filter((x) => x === null).length} из ${d.takenBy.length}</span></div>
    <p class="note">${hint}</p>
    <div class="deck${myTurn ? ' my-turn' : ''}">${slots}</div>
  </div>`);
  return parts.join('');
}

function dayPanel(store: Store, game: GameView, mode: PickMode | null): string {
  const me = game.me;
  const speakerName = game.speaker ? `№${game.speaker} ${esc(game.seats[game.speaker - 1].nick)}` : '';
  const noms = game.nominations.length
    ? game.nominations.map((x) => `№${x.target}`).join(', ')
    : 'пока никого';
  const nomCard = `<div class="card"><div class="row"><span class="k">Выставлены</span><span class="v">${noms}</span></div>
    ${game.noVoteToday ? '<p class="hint">Сегодня голосования не будет: за столом было удаление</p>' : ''}</div>`;

  if (me && me.alive && game.speaker === me.seat) {
    const mine = game.nominations.find((x) => x.by === me.seat);
    return `<div class="card accent">
      <h2>Ваша минута</h2>
      <p class="note">${game.speakerMuted ? 'У вас 3 фола: эту минуту вы молчите, но можете выставить кандидатуру.' : 'Говорите. Закончите словом «Пас» или кнопкой.'}</p>
      ${mine ? `<p class="note">Вы выставили №${mine.target}</p>` : mode ? selectionButton(store, mode) : ''}
      <button class="btn primary" data-act="pass">Пас</button>
    </div>${nomCard}`;
  }
  let wait = '';
  if (me && me.alive) {
    const pos = game.speechQueue.indexOf(me.seat);
    const n = pos + 1;
    const word = n % 10 >= 1 && n % 10 <= 4 && (n % 100 < 11 || n % 100 > 14) ? 'игрока' : 'игроков';
    wait = pos >= 0 ? `Ваша минута через ${n} ${word}` : 'Сегодня вы уже говорили';
  }
  return `<div class="card">
    <p class="note">Говорит ${speakerName}. ${me?.alive ? 'Ваш микрофон выключен до вашей минуты.' : ''}</p>
    ${wait ? `<p class="hint">${wait}</p>` : ''}
  </div>${nomCard}`;
}

function votingPanel(game: GameView): string {
  const v = game.voting!;
  const me = game.me;
  const myVote = me ? v.votes[me.seat] : undefined;
  const counts = new Map<number, number>();
  for (const t of Object.values(v.votes)) counts.set(t, (counts.get(t) ?? 0) + 1);
  const rows = v.candidates.map((c, i) => {
    const s = game.seats[c - 1];
    const by = game.nominations.find((x) => x.target === c);
    const cls = ['cand'];
    if (i === v.index) cls.push('now');
    if (myVote === c) cls.push('mine');
    let btn = '';
    if (me?.alive) {
      if (myVote === c) btn = '<button class="btn small red" disabled>Ваш голос</button>';
      else if (myVote === undefined && i === v.index) btn = `<button class="btn small outline-red" data-act="vote" data-n="${c}">Против</button>`;
    }
    return `<div class="${cls.join(' ')}"><div class="num">${c}</div>
      <div class="who"><b>${esc(s.nick)}</b><small>${by ? `выставил №${by.by}` : 'переголосование'}</small></div>
      <span class="count" aria-label="голосов">${counts.get(c) ?? 0}</span>${btn}</div>`;
  }).join('');
  const last = v.candidates[v.candidates.length - 1];
  return `<div class="stack">${rows}</div>
    <p class="hint">Голос отдаётся один раз. Кто не проголосует, голосует против №${last}, последнего кандидата.</p>`;
}

function liftPanel(game: GameView): string {
  const l = game.lift!;
  const me = game.me;
  const voted = me ? l.yes.includes(me.seat) : false;
  const alive = game.seats.filter((s) => s.alive).length;
  return `<div class="card danger"><h2>Кто за то, чтобы ${l.candidates.map((n) => '№' + n).join(' и ')} покинули стол?</h2>
    <p class="note">Голосов «за»: ${l.yes.length} из ${alive}. Нужно больше половины.</p>
    ${me?.alive ? `<button class="btn red" data-act="liftYes" ${voted ? 'disabled' : ''}>${voted ? 'Вы проголосовали «за»' : 'За'}</button>` : ''}</div>`;
}

function nightPanel(store: Store, game: GameView, mode: PickMode | null): string {
  const me = game.me;
  const step = game.nightStep;
  const blocks: string[] = [];

  if (mode && me) {
    let title = '';
    if (mode.kind === 'shoot') title = 'Мафия выходит на охоту';
    if (mode.kind === 'check') title = me.role === 'don' ? 'Найдите шерифа' : 'Проверьте игрока';
    if (mode.kind === 'bestMove') title = 'Вас убили. Лучший ход';
    blocks.push(`<div class="card ${mode.kind === 'shoot' ? 'danger' : 'accent'}"><h2>${title}</h2>${selectionButton(store, mode)}</div>`);
  } else {
    let text = 'Город спит. Ждите утра.';
    if (me?.team === 'black' && game.myShot !== null) text = `Ваш выстрел в №${game.myShot} принят. Убийство засчитают, только если все живые чёрные выбрали один номер.`;
    const done = game.myChecks.find((c) => c.night === game.night);
    if (done) text = `Проверка принята.`;
    if (game.bestMove && game.bestMoveBy === me?.seat) text = 'Лучший ход принят.';
    blocks.push(`<div class="card"><h2>${esc(NIGHT_STEP[step ?? ''] ?? 'Ночь')}</h2><p class="note">${text}</p></div>`);
  }
  return blocks.join('');
}

function checksCard(game: GameView): string {
  if (!game.me || !game.myChecks.length) return '';
  const isDon = game.me.role === 'don';
  const rows = game.myChecks.map((c) => {
    const res = isDon ? (c.result ? 'шериф' : 'не шериф') : (c.result ? 'чёрный' : 'красный');
    return `<div class="row"><span class="k">Ночь ${c.night}: №${c.target}</span><span class="v ${c.result ? (isDon ? 't-sheriff' : 't-mafia') : ''}">${res}</span></div>`;
  }).join('');
  return `<div class="card"><h2>Ваши проверки</h2>${rows}</div>`;
}

function infoCard(game: GameView): string {
  const out = game.seats.filter((s) => !s.alive);
  const rows: string[] = [];
  if (out.length) rows.push(`<div class="row"><span class="k">Выбыли</span><span class="v">${out.map((s) => `№${s.seat} (${outText(s)})`).join(', ')}</span></div>`);
  if (game.bestMove) rows.push(`<div class="row"><span class="k">Лучший ход №${game.bestMove.by}</span><span class="v">${game.bestMove.seats.join(', ')}</span></div>`);
  return rows.length ? `<div class="card">${rows.join('')}</div>` : '';
}

export function logCard(game: GameView, open: boolean, toggle = true): string {
  // Днём N номер ночи ещё N−1, ночью N они равны; день 0 — договорка
  const mark = (e: { day: number; night: number }) => (e.night === e.day ? 'Н' + e.night : 'Д' + e.day);
  const items = [...game.log].reverse().map((e) => `<div><span>${mark(e)}</span><span>${esc(e.text)}</span></div>`).join('');
  return `<div class="card">
    ${toggle ? `<div class="row"><h2>Протокол</h2><button class="link" data-act="toggleLog">${open ? 'Скрыть' : 'Показать'}</button></div>` : '<h2>Протокол</h2>'}
    ${open || !toggle ? `<div class="log">${items}</div>` : ''}</div>`;
}

export function renderPlay(store: Store): string {
  const game = store.game!;
  const mode = pickMode(game);
  const me = game.me;
  const parts: string[] = [header(store, game)];

  if (!game.mySeat) {
    parts.push('<div class="banner">Вы наблюдатель: слышите игроков и ведущего, роли скрыты до конца партии. Микрофон и чат отключены.</div>');
  } else if (me && !me.alive && game.phase !== 'ended') {
    parts.push('<div class="banner">Вы выбыли и теперь наблюдаете. Ваша роль скрыта от остальных до конца партии. Микрофон и чат отключены, подсказки игрокам запрещены.</div>');
  }

  parts.push(renderTable(game, { mySeat: me?.seat ?? null, selected: store.selected, canPick: mode ? mode.allow : null, offset: store.offset }));

  switch (game.phase) {
    case 'deal':
      parts.push(dealPanel(store, game));
      break;
    case 'zeroNight':
      parts.push(dogovorka(store, game));
      break;
    case 'day':
      parts.push(dayPanel(store, game, mode));
      break;
    case 'tieSpeech':
    case 'lastWord': {
      const mine = me?.seat === game.speaker;
      const what = game.phase === 'tieSpeech' ? 'оправдание, 30 секунд' : 'последняя минута';
      parts.push(mine
        ? `<div class="card accent"><h2>Ваше слово: ${what}</h2><button class="btn primary" data-act="pass">Закончить</button></div>`
        : `<div class="card"><p class="note">Говорит №${game.speaker} ${esc(game.seats[(game.speaker ?? 1) - 1].nick)}: ${what}.</p></div>`);
      break;
    }
    case 'voting':
      parts.push(votingPanel(game));
      break;
    case 'liftVote':
      parts.push(liftPanel(game));
      break;
    case 'night':
      parts.push(nightPanel(store, game, mode));
      break;
    case 'ended':
      parts.push(`<div class="card ended-card"><span class="big">${winnerText(game)}</span><p class="note">${esc(game.endReason)}</p>
        ${me ? `<p class="hint">Ваша роль: ${ROLE_NAME[me.role]}</p>` : ''}
        ${store.room?.you.owner ? '<button class="btn primary" data-act="restart">Сыграть ещё раз</button>' : ''}</div>`);
      break;
  }

  if (me?.alive && game.phase !== 'zeroNight' && game.phase !== 'ended') parts.push(mafiaMemo(game, game.phase === 'night'));
  parts.push(checksCard(game));
  parts.push(infoCard(game));
  if (!['ended', 'zeroNight', 'deal'].includes(game.phase)) {
    parts.push('<p class="hint">Голос пока не подключён: для проверки созвонитесь в любом мессенджере. Сервер уже знает, чей микрофон должен быть открыт.</p>');
  }
  parts.push(logCard(game, store.showLog || game.phase === 'ended'));
  parts.push('<button class="btn ghost" data-act="leave">Выйти из комнаты</button>');
  return `<div class="screen">${parts.join('')}</div>`;
}

// Панель ведущего: на телефоне вкладки, на компьютере две колонки.

import type { GameView } from '../../../engine/index.ts';
import type { Store } from '../store.ts';
import { NIGHT_STEP, ROLE_SHORT, clock, esc, isBlackRole, outText, phaseTitle, remainingMs, winnerText } from '../util.ts';
import { logCard } from './play.ts';

function controlCard(store: Store, game: GameView): string {
  const left = remainingMs(game, store.offset);
  const paused = game.timer !== null && game.timer.endsAt === null;
  const name = (n: number | null) => (n === null ? '' : `№${n} ${esc(game.seats[n - 1].nick)}`);
  let label = '';
  let who = '';
  let next = 'Дальше';
  let extra = '';

  switch (game.phase) {
    case 'deal':
      label = 'Раздача карт';
      who = game.deal?.turn ? `Тянет ${name(game.deal.turn)}` : '';
      next = 'Выдать карту и дальше';
      break;
    case 'zeroNight':
      label = 'Договорка мафии';
      who = game.host?.plan.length ? `План: ${game.host.plan.map((n) => '№' + n).join(', ')}` : 'Дон задаёт план';
      next = 'Начать день';
      break;
    case 'day':
      label = game.speakerMuted ? 'Молчит (3 фола)' : 'Говорит';
      who = name(game.speaker);
      next = game.speechQueue.length ? 'Следующий' : 'К голосованию';
      break;
    case 'tieSpeech':
      label = 'Оправдание';
      who = name(game.speaker);
      break;
    case 'lastWord':
      label = 'Последняя минута';
      who = name(game.speaker);
      break;
    case 'voting': {
      const v = game.voting!;
      label = 'Голосуем против';
      who = name(v.candidates[v.index]);
      next = v.index < v.candidates.length - 1 ? 'Следующий кандидат' : 'Подвести итог';
      const counts = v.candidates.map((c) => `№${c}: ${Object.values(v.votes).filter((t) => t === c).length}`).join(' · ');
      extra = `<p class="hint">Голоса сейчас: ${counts}</p>`;
      break;
    }
    case 'liftVote':
      label = 'Подъём всех';
      who = game.lift!.candidates.map((n) => '№' + n).join(', ');
      next = 'Подвести итог';
      extra = `<p class="hint">«За»: ${game.lift!.yes.length}</p>`;
      break;
    case 'night':
      label = `Ночь ${game.night}`;
      who = NIGHT_STEP[game.nightStep ?? ''] ?? '';
      next = 'Следующий шаг';
      break;
    case 'ended':
      return `<div class="card ended-card"><span class="big">${winnerText(game)}</span><p class="note">${esc(game.endReason)}</p>
        ${store.room?.you.owner ? '<button class="btn primary" data-act="restart">Сыграть ещё раз</button>' : ''}</div>`;
  }

  return `<div class="card accent">
    <div class="row"><div class="stack" style="gap:2px;min-width:0"><span class="eyebrow">${label}</span><b class="ctl-who">${who}</b></div>
      <span class="clock ctl-clock" data-clock style="color:${paused ? 'var(--amber)' : 'var(--blue)'}">${left === null ? '' : clock(left)}</span></div>
    ${paused ? '<p class="hint" style="color:var(--amber)">Пауза. Микрофон говорящего остаётся включённым.</p>' : ''}
    ${extra}
    <div class="grid3 controls">
      <button class="btn small" data-act="${paused ? 'resume' : 'pause'}" ${game.timer ? '' : 'disabled'}>${paused ? 'Продолжить' : 'Пауза'}</button>
      <button class="btn small" data-act="add30" ${game.timer ? '' : 'disabled'}>+30 с</button>
      <button class="btn small primary" data-act="next">${next}</button>
    </div>
  </div>`;
}

function seatRows(store: Store, game: GameView): string {
  return game.seats.map((s) => {
    const role = s.role;
    const cls = ['hseat'];
    const speaking = game.speaker === s.seat && ['day', 'tieSpeech', 'lastWord'].includes(game.phase);
    if (speaking) cls.push('speaking');
    if (!s.alive) cls.push('out');
    const member = store.room?.members.find((m) => m.seat === s.seat);
    const offline = member && !member.connected ? ' · не в сети' : '';
    const status = !s.alive ? ` · ${outText(s)}` : speaking ? ' · говорит' : '';
    let acts = '';
    if (s.alive && game.phase !== 'ended' && game.phase !== 'deal') {
      const armedRemove = store.removeArmed === s.seat;
      const armedPpk = store.ppkArmed === s.seat;
      acts = `<div class="acts">
        <button class="btn tiny foul" data-act="foul" data-n="${s.seat}" aria-label="Фол игроку ${s.seat}">Фол +</button>
        <button class="btn tiny" data-act="unfoul" data-n="${s.seat}" ${s.fouls ? '' : 'disabled'} aria-label="Снять фол с игрока ${s.seat}">−</button>
        <button class="btn tiny ${armedRemove ? 'red' : 'outline-red'}" data-act="remove" data-n="${s.seat}">${armedRemove ? 'Точно?' : 'Удалить'}</button>
        <button class="btn tiny ${armedPpk ? 'red' : 'outline-red'}" data-act="ppk" data-n="${s.seat}">${armedPpk ? 'Точно ППК?' : 'ППК'}</button>
      </div>`;
    }
    return `<div class="${cls.join(' ')}"><span class="num">${s.seat}</span>
      <div class="who"><b>${esc(s.nick)}${offline}</b><small class="t-${role ?? 'none'}">${role ? ROLE_SHORT[role] : 'ждёт карту'}${status}</small></div>
      <span class="fl ${s.fouls >= 3 ? 'warn' : ''}">${s.fouls}/4</span>${acts}</div>`;
  }).join('');
}

function nightCard(game: GameView): string {
  const h = game.host!;
  const rows: string[] = [];
  const row = (k: string, v: string) => rows.push(`<div class="row"><span class="k">${k}</span><span class="v">${v}</span></div>`);
  row('План отстрела', h.plan.length ? h.plan.map((n, i) => `Н${i + 1} №${n}`).join(' · ') : 'не задан');
  row('Маяк дона', h.beacon ? `первый номер +${h.beacon}` : 'без маяка');
  row('Фраза шерифа', `«${esc(h.sheriffPhrase)}»`);
  if (game.phase === 'night') {
    const shots = Object.entries(h.shots).map(([s, t]) => `№${s}→№${t}`).join(', ');
    row(`Выстрелы, ночь ${game.night}`, shots || 'пока нет');
    if (game.nightStep !== 'shoot') row('Итог выстрела', h.nightKill ? `убит №${h.nightKill}` : 'промах');
  }
  for (const c of h.donChecks) row(`Дон, ночь ${c.night}`, `№${c.target} ${c.result ? 'шериф' : 'не шериф'}`);
  for (const c of h.sheriffChecks) row(`Шериф, ночь ${c.night}`, `№${c.target} ${c.result ? 'чёрный' : 'красный'}`);
  if (game.bestMove) row(`Лучший ход №${game.bestMove.by}`, game.bestMove.seats.join(', '));
  if (h.noVoteDays.length) row('Без голосования', h.noVoteDays.map((d) => `день ${d}`).join(', '));
  return `<div class="card"><h2>Ночная информация</h2>${rows.join('')}</div>`;
}

function nominationsCard(game: GameView): string {
  if (!game.nominations.length || !['day', 'voting', 'tieSpeech', 'liftVote'].includes(game.phase)) return '';
  return `<div class="card"><h2>Выставлены</h2>${game.nominations.map((x) =>
    `<div class="row"><span class="v">№${x.target} ${esc(game.seats[x.target - 1].nick)}</span><span class="k">выставил №${x.by}</span></div>`).join('')}</div>`;
}

export function renderHost(store: Store): string {
  const game = store.game!;
  const room = store.room!;
  const alive = game.seats.filter((s) => s.alive);
  const blacks = alive.filter((s) => isBlackRole(s.role)).length;
  const dealing = game.phase === 'deal';
  const tab = store.hostTab;
  const pane = (name: string, html: string) =>
    `<div class="host-pane stack" style="display:${tab === name ? 'flex' : 'none'};gap:14px">${html}</div>`;

  // Шапка, таймер с кнопками и вкладки закреплены сверху: прокручивается только то, что ниже
  return `<div class="screen wide">
    <div class="host-sticky">
      <div class="top"><div class="top-left"><span class="eyebrow">Комната ${esc(room.code)} · вы ведущий</span>
        <h1>${phaseTitle(game)}</h1></div>
        <span class="pill">${room.spectators} зрит.</span></div>
      ${controlCard(store, game)}
      <div class="tabs" role="tablist" aria-label="Разделы панели">
        ${(['table', 'night', 'log'] as const).map((t) => `<button role="tab" data-act="tab" data-v="${t}" aria-selected="${tab === t}">${{ table: 'Стол', night: 'Ночь', log: 'Протокол' }[t]}</button>`).join('')}
      </div>
    </div>
    <div class="host-grid">
      ${pane('table', `<div class="row"><h2>Стол</h2><span class="hint">${dealing ? `Карт роздано: ${game.seats.filter((s) => s.role).length} из ${game.seats.length}` : `Живых ${alive.length}: красных ${alive.length - blacks}, чёрных ${blacks}`}</span></div>
        <div class="stack">${seatRows(store, game)}</div>
        <p class="hint">3-й фол: игрок молчит ближайшую минуту. 4-й фол удаляет его автоматически, голосование дня отменяется.</p>
        ${nominationsCard(game)}`)}
      <div class="stack" style="gap:14px">
        ${pane('night', dealing ? '<div class="card"><h2>Ночная информация</h2><p class="hint">Появится после раздачи</p></div>' : nightCard(game))}
        ${pane('log', logCard(game, true, false))}
      </div>
    </div>
    <button class="btn ghost" data-act="leave">Выйти из комнаты</button>
  </div>`;
}

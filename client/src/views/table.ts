// Круглый стол на 6-10 мест, общий для игрока и наблюдателя.

import type { GameView } from '../../../engine/index.ts';
import { NIGHT_STEP, clock, esc, isBlackRole, outText, remainingMs, seatPosition, winnerText, ROLE_SHORT } from '../util.ts';

export interface TableOptions {
  mySeat: number | null;
  selected: number[];
  canPick: ((n: number) => boolean) | null; // null — сейчас номера не выбираются
  offset: number;
  photos?: Map<number, string>; // фото из Telegram по номеру места
  host?: boolean;               // стол ведущего: все роли открыты, на местах ники и метки
  offline?: Set<number>;        // места, чьи игроки сейчас не в сети
  target?: number | null;       // цель мафии по плану на эту ночь (видят только чёрные)
}

const serverNow = (offset: number) => Date.now() + offset;

const SPEECH_PHASES = ['day', 'tieSpeech', 'lastWord'];

function centerHtml(game: GameView, offset: number): string {
  const left = remainingMs(game, offset);
  const paused = game.timer !== null && game.timer.endsAt === null;
  const timer = left === null ? '' : `<span class="clock" data-clock>${clock(left)}</span>`;
  const sub = paused ? '<span class="sub">пауза</span>' : '';
  const who = (n: number | null) => {
    if (n === null) return '';
    const s = game.seats[n - 1];
    return `<span class="who">№${n} ${esc(s?.nick)}</span>`;
  };

  if (game.hold) {
    const what = { zeroNight: 'Город засыпает', voting: 'Голосование', night: 'Город засыпает' }[game.hold.kind];
    return `<span class="lbl">Ждём ведущего</span><span class="step">${what}</span><span class="sub">скоро объявит</span>`;
  }
  switch (game.phase) {
    case 'deal':
      return `<span class="lbl">Тянет карту</span>${who(game.deal?.turn ?? null)}${timer}${sub}`;
    case 'zeroNight':
      return `<span class="lbl">Договорка</span>${timer}<span class="sub">город спит</span>${sub}`;
    case 'day':
      return `<span class="lbl">${game.speakerMuted ? 'Молчит' : 'Говорит'}</span>${who(game.speaker)}${timer}${sub}`;
    case 'tieSpeech':
      return `<span class="lbl">Оправдание</span>${who(game.speaker)}${timer}${sub}`;
    case 'lastWord':
      return `<span class="lbl">Последняя минута</span>${who(game.speaker)}${timer}${sub}`;
    case 'voting': {
      const v = game.voting!;
      return `<span class="lbl">Голосуем против</span>${who(v.candidates[v.index])}${timer}${sub}`;
    }
    case 'liftVote':
      return `<span class="lbl">Подъём всех</span>${timer}<span class="sub">${game.lift?.candidates.map((n) => '№' + n).join(', ')}</span>${sub}`;
    case 'night':
      return `<span class="lbl">Ночь ${game.night}</span><span class="step">${esc(NIGHT_STEP[game.nightStep ?? ''] ?? '')}</span>${timer}${sub}`;
    case 'ended':
      return `<span class="lbl">Конец</span><span class="who">${winnerText(game)}</span>`;
    default:
      return '';
  }
}

export function renderTable(game: GameView, o: TableOptions): string {
  const nominated = new Set(['day', 'voting', 'tieSpeech'].includes(game.phase) ? game.nominations.map((x) => x.target) : []);
  const seats = game.seats.map((s) => {
    const pos = seatPosition(s.seat, game.seats.length);
    const cls = ['seat'];
    let sub = esc(s.nick);
    if (s.role && isBlackRole(s.role)) {
      cls.push('black');
      if (s.role === 'don') cls.push('don');
      if (s.seat !== o.mySeat && !o.host) sub = ROLE_SHORT[s.role];
    }
    if (o.host && s.role === 'sheriff') cls.push('sheriff');
    if (s.seat === o.mySeat) {
      cls.push('me');
      sub = 'ты';
    }
    if (game.phase === 'ended' && s.role) sub = ROLE_SHORT[s.role];
    if (!s.alive) {
      cls.push('out');
      if (game.phase !== 'ended') sub = outText(s).split(' ')[0];
    }
    if (game.speaker === s.seat && SPEECH_PHASES.includes(game.phase)) cls.push('speaking');
    if (nominated.has(s.seat)) cls.push('nominated');
    const pickable = o.canPick?.(s.seat) ?? false;
    if (pickable) cls.push('pickable');
    if (o.selected.includes(s.seat)) cls.push('selected');
    if (o.target === s.seat && s.alive) cls.push('target');
    if (game.phase === 'deal' && game.deal?.turn === s.seat) cls.push('turn');
    const fouls = s.fouls ? '●'.repeat(s.fouls) : '';
    const photo = o.photos?.get(s.seat);
    // На раздаче: у взявшего карту появляется рубашка (анимация продолжается при перерисовке)
    const got = game.phase === 'deal' && s.dealtAt !== null
      ? `<span class="got" style="animation-delay:${s.dealtAt - serverNow(o.offset)}ms"></span>`
      : '';
    let tag = '';
    if (o.host && s.alive && game.phase !== 'ended') {
      if (o.offline?.has(s.seat)) tag = '<span class="tag off">не в сети</span>';
      else if (cls.includes('speaking')) tag = '<span class="tag">говорит</span>';
    }
    const label = `Место ${s.seat}, ${s.nick}${o.host && s.role ? ', ' + ROLE_SHORT[s.role] : ''}${s.alive ? '' : ', ' + outText(s)}${s.fouls ? `, фолов ${s.fouls}` : ''}`;
    return `<button type="button" class="${cls.join(' ')}" style="left:${pos.left}%;top:${pos.top}%"
      data-act="seat" data-n="${s.seat}" data-vseat="${s.seat}" ${pickable ? '' : 'aria-disabled="true"'} aria-label="${esc(label)}" aria-pressed="${o.selected.includes(s.seat)}">
      ${photo ? `<span class="nrow"><span class="sav"><img src="${esc(photo)}" alt="" referrerpolicy="no-referrer" onerror="this.parentNode.remove()"></span><span class="n">${s.seat}</span></span>` : `<span class="n">${s.seat}</span>`}<span class="s">${sub}</span><span class="f">${fouls}</span>${got}${tag}</button>`;
  }).join('');
  return `<div class="table">${seats}<div class="table-center">${centerHtml(game, o.offset)}</div></div>`;
}

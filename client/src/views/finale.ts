// Конец партии: кто победил, твой результат и все карты стола.

import type { GameView } from '../../../engine/index.ts';
import type { Store } from '../store.ts';
import { ROLE_NAME, ROLE_SHORT, esc, isBlackRole } from '../util.ts';
import { seatArt } from '../art.ts';

const BANNER = {
  red: { title: 'Город победил', sub: 'Мафию вывели на чистую воду. Можно спать спокойно и не прятать колбасу.', art: 'sheriff' },
  black: { title: 'Мафия победила', sub: 'Дон доволен. Город так и не понял, кто съел сметану.', art: 'don' },
  draw: { title: 'Ничья', sub: 'Три ночи никто не ушёл. Все разошлись по коробкам при своих.', art: 'civilian' },
} as const;

export function finaleCard(store: Store, game: GameView): string {
  const w = (game.winner ?? 'draw') as keyof typeof BANNER;
  const b = BANNER[w] ?? BANNER.draw;
  const mySeat = game.mySeat;
  const me = mySeat ? game.seats[mySeat - 1] : null;
  let mine = '';
  if (me?.role) {
    const won = w !== 'draw' && (isBlackRole(me.role) ? w === 'black' : w === 'red');
    mine = `<p class="finale-mine ${w === 'draw' ? '' : won ? 'win' : 'lose'}">Твоя роль: <b class="t-${me.role}">${ROLE_NAME[me.role]}</b>. ${w === 'draw' ? 'Ничья.' : won ? 'Победа!' : 'В этот раз не повезло.'}</p>`;
  }
  const cards = game.seats.map((s) => {
    const role = s.role;
    const team = role && isBlackRole(role) ? 'black' : 'red';
    const won = w !== 'draw' && team === w;
    return `<div class="fcard c-${role ?? 'civilian'} ${won ? 'won' : ''} ${s.alive ? '' : 'out'} ${s.seat === mySeat ? 'me' : ''}">
      ${role ? `<img src="/img/${seatArt(role, s.seat, store.room?.members)}.webp" alt="">` : ''}
      <span class="fnum">${s.seat}</span>
      <span class="fcap"><b>${esc(s.nick)}</b><small>${role ? ROLE_SHORT[role] : ''}</small></span>
    </div>`;
  }).join('');
  const owner = store.room?.you.owner;
  return `<div class="finale t-${w}">
    <div class="finale-banner"><img src="/img/${b.art}.webp" alt="">
      <div><span class="big">${b.title}</span><p>${esc(game.endReason || b.sub)}</p></div></div>
    ${mine}
    <div class="finale-grid">${cards}</div>
    ${owner ? '<button class="btn primary" data-act="restart">Сыграть ещё раз</button>' : '<p class="hint center">Новую партию начинает создатель стола.</p>'}
  </div>`;
}

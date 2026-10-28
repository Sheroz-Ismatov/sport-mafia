// Игровые карты: рубашка и лицо с рисунком роли (котики-мафиози, client/src/img). Маленькие значки ролей — SVG.

import type { Role } from '../../../engine/index.ts';
import { ROLE_NAME } from '../util.ts';

const ICONS: Record<Role, string> = {
  // Мирный житель: силуэт человека
  civilian: '<circle cx="32" cy="21" r="10"/><path d="M13 54c0-11 8.5-19 19-19s19 8 19 19z"/>',
  // Шериф: звезда
  sheriff: '<path d="M32 6l6.6 15.6 16.9 1.4-12.8 11.1 3.9 16.5L32 41.8 17.4 50.6l3.9-16.5L8.5 23l16.9-1.4z"/>',
  // Мафия: шляпа
  mafia: '<path d="M18 40c0-13 4-22 14-22s14 9 14 22z"/><rect x="18" y="33" width="28" height="5" opacity=".45"/><ellipse cx="32" cy="42" rx="26" ry="6"/>',
  // Дон: корона
  don: '<path d="M9 44l4-25 11 12 8-18 8 18 11-12 4 25z"/><rect x="9" y="47" width="46" height="6" rx="2"/>',
};

export function roleIcon(role: Role, size = 64): string {
  return `<svg class="role-icon" width="${size}" height="${size}" viewBox="0 0 64 64" fill="currentColor" aria-hidden="true">${ICONS[role]}</svg>`;
}

export function cardFace(role: Role, art: string = role): string {
  const team = role === 'mafia' || role === 'don' ? 'Чёрные' : 'Красные';
  return `<div class="pcard face art c-${role}">
    <img src="/img/${art}.webp" alt="" draggable="false">
    <span class="corner">${roleIcon(role, 18)}</span>
    <span class="caption"><b>${ROLE_NAME[role]}</b><small>${team}</small></span>
  </div>`;
}

/** Заранее загружаем рисунки, чтобы карта перевернулась уже с картинкой. */
export function preloadCardArt(extra: string[] = []): void {
  for (const r of ['back', 'sheriff', 'mafia', 'don', ...extra]) new Image().src = `/img/${r}.webp`;
}

export function cardBack(): string {
  return '<div class="pcard back art"><img src="/img/back.webp" alt="" draggable="false"></div>';
}

/**
 * Карта, которая переворачивается лицом вверх. elapsedMs — сколько прошло с момента,
 * когда её взяли: анимация продолжается с того же места, даже если экран перерисовался.
 */
export function flippingCard(role: Role, elapsedMs: number, hidden: boolean, art: string = role): string {
  // Сначала карта выезжает из колоды (0,5 с), потом переворачивается (с 0,5 с)
  const t = Math.max(0, Math.round(elapsedMs));
  return `<div class="flip ${hidden ? 'hidden' : ''}" style="animation-delay:${-t}ms">
    <div class="flip-inner" style="animation-delay:${500 - t}ms">
      <div class="flip-side flip-back">${cardBack()}</div>
      <div class="flip-side flip-front">${cardFace(role, art)}</div>
    </div>
  </div>`;
}

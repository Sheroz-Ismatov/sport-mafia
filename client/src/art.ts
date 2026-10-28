// Рисунки карт по ролям и полу. Файлы лежат в client/src/img (имя без .webp).
// Мирных много, чтобы за столом не сидели одинаковые коты. Остальные роли пока по одной.
// Кошки появятся позже: пока их колода пустая, девушкам выпадают коты.

import type { Role } from '../../engine/index.ts';
import type { Gender, MemberInfo } from '../../server/protocol.ts';

type Deck = Record<Role, string[]>;

const CATS: Deck = {
  civilian: ['civilian', 'civilian-barber', 'civilian-driver', 'civilian-fisher', 'civilian-priest', 'civilian-accordion', 'civilian-chef'],
  sheriff: ['sheriff'],
  mafia: ['mafia'],
  don: ['don'],
};

const KITTIES: Deck = {
  civilian: [],
  sheriff: [],
  mafia: [],
  don: [],
};

export const GENDERS: { v: Gender; label: string }[] = [
  { v: 'm', label: 'Парень' },
  { v: 'f', label: 'Девушка' },
  { v: 'x', label: 'Трансформер' },
];

function deck(role: Role, gender: Gender): string[] {
  const cats = CATS[role];
  const kitties = KITTIES[role];
  if (gender === 'f') return kitties.length ? kitties : cats;
  if (gender === 'x') return [...cats, ...kitties];
  return cats;
}

/** Имя рисунка для роли. art — номер, который сервер выдал месту на эту партию. */
export function roleArt(role: Role, gender: Gender = 'm', art: number | null = null): string {
  const d = deck(role, gender);
  return d[(art ?? 0) % d.length];
}

/** Рисунок карты игрока на месте seat: учитывает его пол и номер рисунка. */
export function seatArt(role: Role, seat: number, members: MemberInfo[] | undefined): string {
  const m = members?.find((x) => x.seat === seat);
  return roleArt(role, m?.gender ?? 'm', m?.art ?? seat - 1);
}

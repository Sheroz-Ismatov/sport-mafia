// Время сборов: разбор «пт 21:00», часовые пояса и даты по-русски.
// Telegram не сообщает пояс человека, поэтому у сбора свой пояс (по умолчанию Душанбе).

export const ZONES: { tz: string; city: string }[] = [
  { tz: 'Asia/Dushanbe', city: 'Душанбе' },
  { tz: 'Europe/Moscow', city: 'Москва' },
  { tz: 'Asia/Tashkent', city: 'Ташкент' },
  { tz: 'Asia/Almaty', city: 'Алматы' },
];

export function cityOf(tz: string): string {
  return ZONES.find((z) => z.tz === tz)?.city ?? tz;
}

/** Следующий пояс из списка: кнопка «Пояс» в выборе времени. */
export function nextZone(tz: string): string {
  const i = ZONES.findIndex((z) => z.tz === tz);
  return ZONES[(i + 1) % ZONES.length].tz;
}

/** Части даты в поясе tz. */
function parts(d: Date, tz: string): { y: number; m: number; day: number; h: number; min: number; wd: number } {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short', hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { y: +p.year, m: +p.month, day: +p.day, h: +p.hour, min: +p.minute, wd };
}

/** Местное время в поясе tz → момент UTC. */
export function zoned(y: number, m: number, day: number, h: number, min: number, tz: string): Date {
  let guess = Date.UTC(y, m - 1, day, h, min);
  // Две итерации хватает даже на переходах на летнее время
  for (let i = 0; i < 2; i++) {
    const p = parts(new Date(guess), tz);
    const shown = Date.UTC(p.y, p.m - 1, p.day, p.h, p.min);
    guess += Date.UTC(y, m - 1, day, h, min) - shown;
  }
  return new Date(guess);
}

/** Сегодняшний (или через dayShift дней) день в поясе tz, в заданное время. */
export function at(now: Date, tz: string, dayShift: number, h: number, min: number): Date {
  const p = parts(now, tz);
  const base = new Date(Date.UTC(p.y, p.m - 1, p.day + dayShift));
  return zoned(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), h, min, tz);
}

const WEEKDAYS: [RegExp, number][] = [
  [/^(вс|воскр\S*)$/, 0], [/^(пн|понед\S*)$/, 1], [/^(вт|вторн\S*)$/, 2], [/^(ср|сред\S*|среду)$/, 3],
  [/^(чт|четв\S*)$/, 4], [/^(пт|пятн\S*)$/, 5], [/^(сб|субб\S*)$/, 6],
];
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

/**
 * Разбор времени сбора: «21:00», «в 21», «завтра 20:30», «пт 21:00», «в пятницу в 20», «1.11 20:00», «1 ноября 19:30».
 * Без дня: сегодня, а если время уже прошло, завтра. Вернёт null, если не понял.
 */
export function parseWhen(text: string, now: Date, tz: string): Date | null {
  const s = text.toLowerCase().replace(/ё/g, 'е').replace(/[,]/g, ' ').replace(/\s+/g, ' ').trim();
  // Время: 21:00, 21.00, 21-00, «в 21», «21ч»
  const tm = /(?:^|\s|в\s?)(\d{1,2})(?:[:.\-](\d{2}))?\s*(?:ч\S*)?(?:\s*(утра|дня|вечера|ночи))?\s*$/.exec(s)
    ?? /(\d{1,2})[:.](\d{2})/.exec(s);
  if (!tm) return null;
  let h = +tm[1];
  const min = tm[2] ? +tm[2] : 0;
  const part = (tm as RegExpExecArray)[3];
  if (part === 'вечера' || part === 'дня') { if (h < 12) h += 12; }
  if (part === 'ночи' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  const rest = s.slice(0, tm.index).replace(/(^|\s)в(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
  const p = parts(now, tz);

  if (!rest || rest === 'сегодня') {
    const d = at(now, tz, 0, h, min);
    return !rest && d.getTime() <= now.getTime() ? at(now, tz, 1, h, min) : d;
  }
  if (rest === 'завтра') return at(now, tz, 1, h, min);
  if (rest === 'послезавтра') return at(now, tz, 2, h, min);
  for (const [re, wd] of WEEKDAYS) {
    if (re.test(rest)) {
      let shift = (wd - p.wd + 7) % 7;
      const d = at(now, tz, shift, h, min);
      if (d.getTime() <= now.getTime()) shift += 7;
      return at(now, tz, shift, h, min);
    }
  }
  // 1.11, 01.11.2026
  const dm = /^(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?$/.exec(rest);
  // 1 ноября
  const dn = /^(\d{1,2}) ([а-я]+)$/.exec(rest);
  let day = 0, mon = 0, year = 0;
  if (dm) { day = +dm[1]; mon = +dm[2]; year = dm[3] ? +dm[3] : 0; }
  else if (dn) { day = +dn[1]; mon = MONTHS.findIndex((x) => dn[2].startsWith(x)) + 1; }
  if (!day || mon < 1 || mon > 12 || day > 31) return null;
  if (year && year < 100) year += 2000;
  let d = zoned(year || p.y, mon, day, h, min, tz);
  if (!year && d.getTime() < now.getTime() - 12 * 3600_000) d = zoned(p.y + 1, mon, day, h, min, tz);
  return d;
}

const WD_RU = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const MON_RU = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

/** «пятница, 1 ноября, 21:00» в поясе сбора; «сегодня» и «завтра» вместо дня недели. */
export function formatWhen(d: Date, tz: string, now = new Date()): string {
  const p = parts(d, tz);
  const n = parts(now, tz);
  const time = `${p.h}:${String(p.min).padStart(2, '0')}`;
  const dayDiff = Math.round((Date.UTC(p.y, p.m - 1, p.day) - Date.UTC(n.y, n.m - 1, n.day)) / 86400_000);
  const date = `${p.day} ${MON_RU[p.m - 1]}`;
  if (dayDiff === 0) return `сегодня, ${date}, ${time}`;
  if (dayDiff === 1) return `завтра, ${date}, ${time}`;
  return `${WD_RU[p.wd]}, ${date}, ${time}`;
}

/** Часы и минуты в поясе: для расписания фразы дня. */
export function localHM(d: Date, tz: string): { h: number; min: number; dayKey: string } {
  const p = parts(d, tz);
  return { h: p.h, min: p.min, dayKey: `${p.y}-${p.m}-${p.day}` };
}

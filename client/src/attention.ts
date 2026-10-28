// Чтобы не пропустить свою минуту: экран не гаснет во время партии, короткий звуковой сигнал.
// Всё молча пропускается, если браузер этого не умеет.

// ---------- Экран не гаснет ----------

type Sentinel = { released: boolean; release(): Promise<void>; addEventListener(t: 'release', f: () => void): void };
let lock: Sentinel | null = null;
let wanted = false;
let pending = false;

async function acquire(): Promise<void> {
  const wl = (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<Sentinel> } }).wakeLock;
  if (!wl || pending || (lock && !lock.released) || document.visibilityState !== 'visible') return;
  pending = true;
  try {
    lock = await wl.request('screen');
    lock.addEventListener('release', () => { lock = null; });
    if (!wanted) await release(); // пока ждали, партия закончилась
  } catch {
    lock = null; // нет разрешения или экономия батареи: просто без блокировки
  } finally {
    pending = false;
  }
}

async function release(): Promise<void> {
  const l = lock;
  lock = null;
  try { await l?.release(); } catch { /* уже снята */ }
}

/** Включить или снять блокировку сна экрана. Вызывается на каждой отрисовке, лишних запросов не делает. */
export function keepAwake(on: boolean): void {
  if (on === wanted && (!on || lock)) return;
  wanted = on;
  if (on) void acquire();
  else void release();
}

// Браузер снимает блокировку, когда вкладку свернули: возвращаем её, когда снова видна
document.addEventListener('visibilitychange', () => {
  if (wanted && document.visibilityState === 'visible') void acquire();
});

// ---------- Звук ----------

let ctx: AudioContext | null = null;

/** Браузер разрешает звук только после нажатия на страницу: готовим его при первом касании. */
function unlock(): void {
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    ctx ??= new AC();
    if (ctx.state === 'suspended') void ctx.resume();
  } catch {
    ctx = null;
  }
}
for (const ev of ['pointerdown', 'keydown', 'touchstart'] as const) window.addEventListener(ev, unlock, { passive: true });

function tone(freq: number, start: number, dur: number, gain = 0.18): void {
  if (!ctx) return;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = 'sine';
  o.frequency.value = freq;
  const t = ctx.currentTime + start;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(ctx.destination);
  o.start(t);
  o.stop(t + dur + 0.05);
}

/** Короткий сигнал: «turn» — твоя очередь (два восходящих тона), «alert» — тебя выставили (три коротких). */
export function chime(kind: 'turn' | 'alert'): void {
  if (!ctx || ctx.state !== 'running') return;
  if (kind === 'turn') {
    tone(660, 0, 0.18);
    tone(990, 0.16, 0.28);
  } else {
    tone(520, 0, 0.1);
    tone(520, 0.14, 0.1);
    tone(520, 0.28, 0.14);
  }
}

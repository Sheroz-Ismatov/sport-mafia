// Сборка интерфейса: client/src → client/dist. Запуск: npm run build (или --watch для разработки)

import { build, context } from 'esbuild';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const dist = new URL('./dist/', import.meta.url);
await mkdir(dist, { recursive: true });
await copyFile(new URL('./src/index.html', import.meta.url), new URL('index.html', dist));
await copyFile(new URL('./src/styles.css', import.meta.url), new URL('styles.css', dist));

const options = {
  entryPoints: [fileURLToPath(new URL('./src/main.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('app.js', dist)),
  bundle: true,
  format: 'esm' as const,
  target: ['es2020', 'safari15'],
  sourcemap: false,
  minify: !process.argv.includes('--watch'),
  logLevel: 'info' as const,
};

// Голос: livekit-client и шумоподавление Krisp собираются отдельно в client/dist/lk/.
// Браузер грузит их, только когда человек включает голос. Krisp — отдельный кусок, грузится после подключения.
// Если пакетов нет (npm install не выполнен), игра соберётся без голоса.
const installed = (pkg: string) => existsSync(fileURLToPath(new URL(`../node_modules/${pkg}/package.json`, import.meta.url)));
await rm(new URL('lk/', dist), { recursive: true, force: true });
if (installed('livekit-client')) {
  const krisp = installed('@livekit/krisp-noise-filter');
  const entry = new URL('./.lk-entry.js', import.meta.url);
  await writeFile(entry, [
    "export { Room } from 'livekit-client';",
    krisp ? "export const loadKrisp = () => import('@livekit/krisp-noise-filter');" : 'export const loadKrisp = null;',
  ].join('\n'));
  try {
    await build({
      entryPoints: { lk: fileURLToPath(entry) },
      outdir: fileURLToPath(new URL('lk/', dist)),
      bundle: true,
      splitting: true,
      format: 'esm',
      target: ['es2020', 'safari15'],
      minify: true,
      logLevel: 'warning',
    });
    console.log(`Голос собран${krisp ? ' вместе с шумоподавлением Krisp' : ', Krisp не установлен'}`);
  } finally {
    await rm(entry, { force: true });
  }
} else {
  console.log('livekit-client не установлен: интерфейс собран без голоса (выполните npm install)');
}

if (process.argv.includes('--watch')) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('Слежу за изменениями в client/src');
} else {
  await build(options);
}

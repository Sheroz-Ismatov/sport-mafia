// Сборка интерфейса: client/src → client/dist. Запуск: npm run build (или --watch для разработки)

import { build, context } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
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

if (process.argv.includes('--watch')) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('Слежу за изменениями в client/src');
} else {
  await build(options);
}

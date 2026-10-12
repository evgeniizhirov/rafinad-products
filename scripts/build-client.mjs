// Builds the React client into dist/client with esbuild (hashed assets + index.html).
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist', 'client');
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'assets'), { recursive: true });

const result = await build({
  entryPoints: [join(root, 'client', 'src', 'main.tsx')],
  bundle: true,
  minify: true,
  sourcemap: false,
  format: 'esm',
  target: ['es2022', 'chrome110', 'safari16', 'firefox115'],
  jsx: 'automatic',
  outdir: join(out, 'assets'),
  entryNames: 'app-[hash]',
  assetNames: '[name]-[hash]',
  metafile: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'none',
  logLevel: 'warning',
});

const files = Object.keys(result.metafile.outputs).map((f) => basename(f));
const js = files.find((f) => f.endsWith('.js'));
const css = files.find((f) => f.endsWith('.css'));
cpSync(join(root, 'client', 'public'), out, { recursive: true });

writeFileSync(
  join(out, 'index.html'),
  `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Rafinad Roadmap</title>
<meta name="description" content="Продуктовый бэклог, приоритеты отделов, ресурсное планирование и релизы платформы Rafinad." />
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Golos+Text:wght@400;500;600;700&family=Unbounded:wght@500;600&display=swap" />
${css ? `<link rel="stylesheet" href="/assets/${css}" />` : ''}
<script type="module" src="/assets/${js}"></script>
</head>
<body>
<div id="root"></div>
<noscript>Для работы приложения включите JavaScript.</noscript>
</body>
</html>
`,
);
const size = Object.values(result.metafile.outputs).reduce((s, o) => s + o.bytes, 0);
console.log(`client built: ${js}${css ? `, ${css}` : ''} (${Math.round(size / 1024)} KB)`);

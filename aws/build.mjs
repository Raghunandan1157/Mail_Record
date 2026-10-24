// Builds dist/ — the folder that runs on the AWS server (aws/server.js).
//
//   npm run build:aws                               # → dist/  (not "build": Vercel would run it)
//   cd dist && npm ci --omit=dev
//   node --env-file=../.env.local aws/server.js     # http://127.0.0.1:3104
//
// The api/ handlers are TypeScript; Vercel compiled them for us. Here esbuild
// turns each route into one plain .js file (the "_" helpers are bundled into
// the routes that import them) and leaves npm packages as imports, installed in
// dist/ by `npm ci --omit=dev`. Only the public pages, script.js and style.css
// are copied — the .sql files, tests and notes never leave this Mac.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

const routes = [
  ...fs.readdirSync(path.join(ROOT, 'api')).filter(f => f.endsWith('.ts') && !f.startsWith('_')).map(f => `api/${f}`),
  'api/rest/v1/[table].ts',
];

fs.rmSync(DIST, { recursive: true, force: true });
await build({
  absWorkingDir: ROOT,
  entryPoints: routes,
  outbase: 'api',
  outdir: 'dist/api',
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  target: 'node22',
  logLevel: 'warning',
});

const pages = fs.readdirSync(ROOT).filter(f => /^[a-z_]+\.html$/.test(f));
for (const f of [...pages, 'script.js', 'style.css', 'package.json', 'package-lock.json', 'aws/server.js']) {
  fs.mkdirSync(path.dirname(path.join(DIST, f)), { recursive: true });
  fs.copyFileSync(path.join(ROOT, f), path.join(DIST, f));
}
console.log(`dist/: ${routes.length} api routes, ${pages.length} pages`);

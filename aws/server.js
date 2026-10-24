// Mail Record on our own AWS server (moved off Vercel 2026-10-05). One Node
// process standing in for Vercel; same shape as NVSSN Mail Record's
// aws/server.js. The api/ handlers are Web-style (Request in, Response out), so
// this file builds a Request from the Node request and writes the Response
// back. Node 22 has fetch, Request, Response, crypto.subtle, atob and btoa
// built in, which is everything the api/ tree uses.
//
// It runs from dist/ (made by aws/build.mjs), where api/ holds the handlers
// compiled from TypeScript to plain .js.
//
// Vercel did three things for us, and this file does the same three:
//   1. ran api/<name> as /api/<name> — files starting with "_" are helpers,
//      never routes;
//   2. ran api/rest/v1/[table] for /api/rest/v1/<table> (the dynamic route);
//   3. served the static site — but only the pages, script.js and style.css.
//      Vercel served the whole folder (the .sql files, CLAUDE.md, tests);
//      here anything not on PUBLIC is a 404.
//
// nginx terminates HTTPS in front, gzips responses and passes X-Forwarded-*;
// pm2 keeps it up (/opt/sites/mail-record). Secrets arrive as env vars from
// shared/.env.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = +process.env.PORT || 3104;
const HOST = process.env.HOSTNAME || '127.0.0.1';
// nginx caps bodies at 12 MB; nothing here takes more than a JSON form.
const MAX_BODY = 12 * 1024 * 1024;

const PUBLIC = [/^\/[a-z_]+\.html$/, /^\/script\.js$/, /^\/style\.css$/];

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
};

// ── API ───────────────────────────────────────────────────────────────────────
// A handler module is imported on first use and kept. A module that throws on
// import fails only its own route, as on Vercel.
const handlers = new Map();
async function handlerFor(file) {
  if (!handlers.has(file)) {
    handlers.set(file, fs.existsSync(file)
      ? import(pathToFileURL(file).href).then(m => m.default)
      : Promise.resolve(null));
  }
  return handlers.get(file);
}

function apiFile(pathname) {
  const rest = /^\/api\/rest\/v1\/([A-Za-z0-9_]+)\/?$/.exec(pathname);
  if (rest) return path.join(ROOT, 'api', 'rest', 'v1', '[table].js');
  const m = /^\/api\/([a-z][a-z0-9-]*)\/?$/.exec(pathname);
  return m ? path.join(ROOT, 'api', m[1] + '.js') : null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function runApi(file, req, res) {
  const handler = await handlerFor(file);
  if (typeof handler !== 'function') { res.statusCode = 404; return res.end('Not found'); }

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  }
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const hasBody = !['GET', 'HEAD'].includes(req.method);
  const request = new Request(`${proto}://${host}${req.url}`, {
    method: req.method,
    headers,
    body: hasBody ? await readBody(req) : undefined,
  });

  const response = await handler(request);
  if (!(response instanceof Response)) throw new Error('handler did not return a Response');
  res.statusCode = response.status;
  response.headers.forEach((v, k) => { if (k !== 'set-cookie') res.setHeader(k, v); });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) res.setHeader('set-cookie', cookies);
  const buf = Buffer.from(await response.arrayBuffer());
  // Handlers catch their own errors and answer 5xx with {error}; log the reason
  // so pm2's error log shows why a branch got a 500.
  if (response.status >= 500) console.error(new Date().toISOString(), response.status, req.method, req.url.split('?')[0], buf.toString('utf8', 0, 400));
  res.end(req.method === 'HEAD' ? undefined : buf);
}

// ── Static ────────────────────────────────────────────────────────────────────
function serveStatic(pathname, req, res) {
  if (!['GET', 'HEAD'].includes(req.method)) { res.statusCode = 405; return res.end(); }
  const p = pathname === '/' ? '/index.html' : pathname;
  if (!PUBLIC.some(re => re.test(p))) { res.statusCode = 404; return res.end('Not found'); }
  const file = path.join(ROOT, p);
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.statusCode = 404; return res.end('Not found'); }
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    res.setHeader('Content-Type', TYPES[path.extname(file)]);
    // Always revalidate (vercel.json did the same): a deploy must reach every
    // branch on its next load.
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.setHeader('ETag', etag);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.headers['if-none-match'] === etag) { res.statusCode = 304; return res.end(); }
    res.setHeader('Content-Length', st.size);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

// ── Server ────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://local').pathname);
    if (pathname.includes('\0') || pathname.split('/').includes('..')) { res.statusCode = 400; return res.end(); }
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      const file = apiFile(pathname);
      if (!file) { res.statusCode = 404; return res.end('Not found'); }
      return await runApi(file, req, res);
    }
    return serveStatic(pathname, req, res);
  } catch (e) {
    console.error(new Date().toISOString(), req.method, req.url.split('?')[0], e && e.stack || e);
    if (!res.headersSent) {
      res.statusCode = e.status || 500;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    if (!res.writableEnded) res.end(JSON.stringify({ error: e.status ? e.message : 'server error' }));
  }
});

// The AI chat waits on DeepSeek; nginx gives it 120 s, so give the socket a bit more.
server.requestTimeout = 150 * 1000;
server.headersTimeout = 60 * 1000;
server.keepAliveTimeout = 65 * 1000;
server.listen(PORT, HOST, () => console.log(`mail-record on ${HOST}:${PORT}`));

process.on('unhandledRejection', e => console.error('unhandledRejection', e && e.stack || e));

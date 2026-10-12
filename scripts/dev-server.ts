// Local development server without Cloudflare tooling: runs the real worker code on Node with
// SQLite (node:sqlite) in place of D1, and serves the built client.
//   npm run dev:node            → http://localhost:8788
// Env: PORT, DB_FILE (default .local/dev.sqlite), ADMIN_EMAIL, ADMIN_PASSWORD (first run only)

import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import worker from '../worker/index';
import type { Env, Fetcher } from '../worker/env';
import { hashPassword, tempPassword } from '../worker/lib/crypto';
import { seedSql } from './gen-seed';
import { createD1, migrate } from './sqlite-d1';

const root = join(import.meta.dirname, '..');
const dist = join(root, 'dist', 'client');
const port = Number(process.env.PORT || 8788);
const dbFile = process.env.DB_FILE || join(root, '.local', 'dev.sqlite');
mkdirSync(join(root, '.local'), { recursive: true });
const fresh = !existsSync(dbFile);
const db = createD1(dbFile);

migrate(db); // applies only migrations missing in this database
if (fresh) {
  for (const s of seedSql()) db.raw.exec(s);
  const email = process.env.ADMIN_EMAIL || 'admin@rafinad.test';
  const password = process.env.ADMIN_PASSWORD || tempPassword();
  const now = new Date().toISOString();
  db.raw.prepare(`INSERT INTO users (id, email, name, role_code, password_hash, must_change_password, is_active, created_at, updated_at)
    VALUES ('u_admin', ?, 'Администратор', 'admin', ?, ?, 1, ?, ?)`).run(email, await hashPassword(password), process.env.ADMIN_PASSWORD ? 0 : 1, now, now);
  db.raw.prepare(`INSERT INTO department_memberships (user_id, department_id) VALUES ('u_admin', 'dep_product')`).run();
  console.log(`\nНовая база ${dbFile}\nАдминистратор: ${email}\nПароль: ${password}${process.env.ADMIN_PASSWORD ? '' : ' (временный — смените при первом входе)'}\n`);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};

const assets: Fetcher = {
  async fetch(input: Request | string) {
    const url = new URL(typeof input === 'string' ? input : input.url);
    let p = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    let file = join(dist, p);
    if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html'); // SPA fallback
    p = file;
    return new Response(readFileSync(p), { headers: { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' } });
  },
};

const env: Env = { DB: db, ASSETS: assets, COOKIE_SECURE: '0', GOOGLE_SERVICE_ACCOUNT_JSON: process.env.GOOGLE_SERVICE_ACCOUNT_JSON };

createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request(`http://localhost:${port}${req.url}`, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
    });
    const r = await worker.fetch(request, env);
    const headers: Record<string, string | string[]> = {};
    r.headers.forEach((v, k) => { if (k !== 'set-cookie') headers[k] = v; });
    const cookies = r.headers.getSetCookie?.() ?? [];
    if (cookies.length) headers['set-cookie'] = cookies;
    res.writeHead(r.status, headers);
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    console.error(e);
    res.writeHead(500);
    res.end('dev server error');
  }
}).listen(port, () => console.log(`Rafinad Roadmap: http://localhost:${port}`));

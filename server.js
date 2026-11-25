#!/usr/bin/env node
// Addy server.
// Node 22.5+. Stores data in PostgreSQL when DATABASE_URL is set (needs the "pg" package), otherwise in a local SQLite file.
// Serves the web app from ./public and a small JSON API for accounts, projects and point sync.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './database.js';

const VERSION = '1.0.0';
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const PORT = Number(process.env.PORT) || 8080;
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 8443;
const SESSION_DAYS = 30;          // "Keep me signed in"
const SHORT_SESSION_HOURS = 12;   // without it: a browser-session cookie, and the server forgets it after 12 h
const COOKIE = 'addy_session';
const MAX_BODY = 40 * 1024 * 1024; // photos travel inside sync bodies

const db = await openDatabase({ url: process.env.DATABASE_URL, dataDir: DATA_DIR });

// ---------- helpers ----------
const now = () => Date.now();
const iso = () => new Date().toISOString();
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
// One counter for every change. Inside a sync transaction this row stays locked until COMMIT,
// so changes become visible in sequence order and a client never skips one.
async function nextSeq(t) {
  const r = await t.get(`INSERT INTO meta(k, v) VALUES('seq', '1') ON CONFLICT(k) DO UPDATE SET v = CAST(CAST(meta.v AS INTEGER) + 1 AS TEXT) RETURNING v`);
  return Number(r.v);
}
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const h = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  const want = Buffer.from(hashHex, 'hex');
  return want.length === h.length && crypto.timingSafeEqual(h, want);
}
const ROLES = ['admin', 'manager', 'collector'];
const publicUser = u => u && { id: u.id, username: u.username, name: u.name, role: u.role, active: !!u.active, created_at: u.created_at, last_login: u.last_login || null, must_change: !!u.must_change };
function validUsername(s) { return typeof s === 'string' && /^[A-Za-z0-9._-]{2,40}$/.test(s); }
function validPassword(s) { return typeof s === 'string' && s.length >= 6 && s.length <= 200; }
function cleanStr(s, max = 500) { return typeof s === 'string' ? s.trim().slice(0, max) : ''; }
// ---------- cookies ----------
// The session lives in an HttpOnly cookie, so page scripts never see the token.
// SameSite=Lax plus the X-Addy header check in handler() keep other sites from using it.
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) { const k = part.slice(0, i).trim(); if (k) { try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* skip malformed */ } } }
  }
  return out;
}
const isSecure = req => !!req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
function sessionCookie(req, token, remember) {
  const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (remember) parts.push(`Max-Age=${SESSION_DAYS * 86400}`);
  if (isSecure(req)) parts.push('Secure');
  return parts.join('; ');
}
const clearCookie = req => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isSecure(req) ? '; Secure' : ''}`;

async function newSession(userId, remember = true) {
  const token = crypto.randomBytes(32).toString('base64url');
  const life = remember ? SESSION_DAYS * 864e5 : SHORT_SESSION_HOURS * 36e5;
  await db.run(`INSERT INTO sessions(token_hash, user_id, expires_at) VALUES(?, ?, ?)`, sha256(token), userId, now() + life);
  await db.run(`DELETE FROM sessions WHERE expires_at < ?`, now());
  await db.run(`UPDATE users SET last_login = ? WHERE id = ?`, iso(), userId);
  return token;
}
async function signIn(ctx, u, remember) {
  const token = await newSession(u.id, remember);
  ctx.setCookie(sessionCookie(ctx.req, token, remember));
  return { user: publicUser(await userById(u.id)) };
}
function cleanClasses(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  const seen = new Set();
  for (const c of list.slice(0, 100)) {
    const name = cleanStr(c && c.name, 80);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const code = Number.isFinite(+c.code) ? Math.round(+c.code) : out.length + 1;
    const color = /^#[0-9a-fA-F]{6}$/.test(c.color || '') ? c.color : '#607d8b';
    out.push({ code, name, color });
  }
  return out.length ? out : null;
}
function projectRow(p, extra) {
  return p && {
    id: p.id, name: p.name, description: p.description, classes: JSON.parse(p.classes), created_by: p.created_by, created_at: p.created_at, updated_at: p.updated_at, archived: !!p.archived,
    ...(extra || {}),
  };
}
// admins and managers edit any project; anyone else edits the projects they created
const canEditProject = (user, p) => user.role !== 'collector' || p.created_by === user.id;
const userCount = async () => (await db.get(`SELECT COUNT(*) AS n FROM users`)).n;
const userById = id => db.get(`SELECT * FROM users WHERE id = ?`, id);
// usernames are ASCII (see validUsername), so lower() matches them case-insensitively in both databases
const userByName = name => db.get(`SELECT * FROM users WHERE lower(username) = lower(?)`, name);
const projectById = id => db.get(`SELECT * FROM projects WHERE id = ?`, id);

// simple login throttling: 10 failures per 15 minutes per ip+username
const fails = new Map();
function throttled(key) {
  const f = fails.get(key);
  if (!f) return false;
  if (now() - f.first > 15 * 60e3) { fails.delete(key); return false; }
  return f.n >= 10;
}
function noteFail(key) {
  const f = fails.get(key);
  if (!f || now() - f.first > 15 * 60e3) fails.set(key, { n: 1, first: now() });
  else f.n++;
}

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const need = (cond, status, msg) => { if (!cond) throw new HttpError(status, msg); };

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'Body is not valid JSON')); }
    });
    req.on('error', reject);
  });
}

// The session token comes from the cookie. Older app versions sent it as a Bearer header;
// that still works, and the reply moves the token into a cookie so the app can drop its copy.
function sessionToken(req) {
  const c = parseCookies(req)[COOKIE];
  if (c) return { token: c, via: 'cookie' };
  const m = /^Bearer\s+(.+)$/.exec(req.headers.authorization || '');
  return m ? { token: m[1], via: 'bearer' } : null;
}
async function authUser(req) {
  const t = sessionToken(req);
  if (!t) return null;
  const row = await db.get(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`, sha256(t.token), now());
  return row ? { user: row, ...t } : null;
}

// ---------- API ----------
const routes = [];
const route = (method, pattern, fn, opts = {}) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn, opts });

route('GET', '/api/status', async () => ({
  ok: true, version: VERSION,
  needsSetup: (await userCount()) === 0,
}), { public: true });

route('POST', '/api/setup', async ctx => {
  const { body } = ctx;
  need((await userCount()) === 0, 409, 'Setup has already been done. Sign in instead.');
  need(validUsername(body.username), 400, 'Username: 2–40 letters, numbers, dot, dash or underscore.');
  need(validPassword(body.password), 400, 'Password must be at least 6 characters.');
  const name = cleanStr(body.name, 80) || body.username;
  const user = await db.get(`INSERT INTO users(username, name, role, pass, created_at) VALUES(?, ?, 'admin', ?, ?) RETURNING *`, body.username, name, hashPassword(body.password), iso());
  return signIn(ctx, user, body.remember !== false);
}, { public: true });

route('POST', '/api/login', async ctx => {
  const { body, req } = ctx;
  const key = (req.socket.remoteAddress || '') + '|' + String(body.username || '').toLowerCase();
  need(!throttled(key), 429, 'Too many failed attempts. Wait 15 minutes and try again.');
  const u = await userByName(String(body.username || ''));
  if (!u || !u.active || !checkPassword(String(body.password || ''), u.pass)) { noteFail(key); throw new HttpError(401, 'Wrong username or password.'); }
  fails.delete(key);
  return signIn(ctx, u, body.remember !== false);
}, { public: true });

route('POST', '/api/logout', async ({ req, setCookie }) => {
  const t = sessionToken(req);
  if (t) await db.run(`DELETE FROM sessions WHERE token_hash = ?`, sha256(t.token));
  setCookie(clearCookie(req));
  return { ok: true };
}, { public: true });

route('GET', '/api/me', ({ user }) => ({ user: publicUser(user) }));

route('POST', '/api/me/password', async ({ user, body, req }) => {
  need(checkPassword(String(body.current || ''), user.pass), 400, 'Current password is wrong.');
  need(validPassword(body.next), 400, 'New password must be at least 6 characters.');
  need(body.next !== body.current, 400, 'Choose a password different from the current one.');
  await db.run(`UPDATE users SET pass = ?, must_change = 0 WHERE id = ?`, hashPassword(body.next), user.id);
  // keep this device signed in, sign out everywhere else
  const t = sessionToken(req);
  await db.run(`DELETE FROM sessions WHERE user_id = ? AND token_hash != ?`, user.id, t ? sha256(t.token) : '');
  return { ok: true, user: publicUser(await userById(user.id)) };
});

route('GET', '/api/users', async ({ user }) => {
  need(user.role === 'admin', 403, 'Only an admin can manage the team.');
  return { users: (await db.all(`SELECT * FROM users ORDER BY lower(name)`)).map(publicUser) };
});

route('POST', '/api/users', async ({ user, body }) => {
  need(user.role === 'admin', 403, 'Only an admin can add people.');
  need(validUsername(body.username), 400, 'Username: 2–40 letters, numbers, dot, dash or underscore.');
  need(validPassword(body.password), 400, 'Password must be at least 6 characters.');
  need(ROLES.includes(body.role), 400, 'Role must be admin, manager or collector.');
  need(!(await userByName(body.username)), 409, 'That username is taken.');
  // must_change: they choose their own password the first time they sign in
  const created = await db.get(`INSERT INTO users(username, name, role, pass, created_at, must_change) VALUES(?, ?, ?, ?, ?, 1) RETURNING *`,
    body.username, cleanStr(body.name, 80) || body.username, body.role, hashPassword(body.password), iso());
  return { user: publicUser(created) };
});

route('PATCH', '/api/users/:id', async ({ user, body, params }) => {
  need(user.role === 'admin', 403, 'Only an admin can change accounts.');
  const target = await userById(Number(params.id) || 0);
  need(target, 404, 'No such user.');
  const adminsLeft = async () => (await db.get(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id != ?`, target.id)).n;
  if (body.role !== undefined) {
    need(ROLES.includes(body.role), 400, 'Bad role.');
    if (target.role === 'admin' && body.role !== 'admin') need((await adminsLeft()) > 0, 400, 'Keep at least one active admin.');
    await db.run(`UPDATE users SET role = ? WHERE id = ?`, body.role, target.id);
  }
  if (body.active !== undefined) {
    if (!body.active && target.role === 'admin') need((await adminsLeft()) > 0, 400, 'Keep at least one active admin.');
    await db.run(`UPDATE users SET active = ? WHERE id = ?`, body.active ? 1 : 0, target.id);
    if (!body.active) await db.run(`DELETE FROM sessions WHERE user_id = ?`, target.id);
  }
  if (body.name !== undefined) await db.run(`UPDATE users SET name = ? WHERE id = ?`, cleanStr(body.name, 80) || target.username, target.id);
  if (body.password !== undefined) {
    need(validPassword(body.password), 400, 'Password must be at least 6 characters.');
    await db.run(`UPDATE users SET pass = ?, must_change = ? WHERE id = ?`, hashPassword(body.password), target.id === user.id ? 0 : 1, target.id);
    await db.run(`DELETE FROM sessions WHERE user_id = ?`, target.id);
  }
  return { user: publicUser(await userById(target.id)) };
});

// Every project with a few figures for the project cards.
// Collectors see archived projects only if they created them.
route('GET', '/api/projects', async ({ user }) => {
  const blank = () => ({ points: 0, mine: 0, people: 0, datasets: 0, last_activity: null });
  const stats = new Map();
  const pts = await db.all(`SELECT project_id, COUNT(*) AS n, COUNT(DISTINCT user_id) AS people,
      SUM(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS mine, MAX(updated_at) AS last
    FROM points WHERE deleted = 0 GROUP BY project_id`, user.id);
  for (const r of pts) stats.set(r.project_id, { ...blank(), points: Number(r.n), people: Number(r.people), mine: Number(r.mine || 0), last_activity: r.last ? Number(r.last) : null });
  for (const r of await db.all(`SELECT project_id, COUNT(*) AS n FROM datasets WHERE deleted = 0 GROUP BY project_id`)) {
    const s = stats.get(r.project_id) || blank(); s.datasets = Number(r.n); stats.set(r.project_id, s);
  }
  const names = new Map((await db.all(`SELECT id, name FROM users`)).map(u => [u.id, u.name]));
  const rows = await db.all(`SELECT * FROM projects ORDER BY archived, lower(name)`);
  return {
    projects: rows
      .filter(p => !p.archived || canEditProject(user, p))
      .map(p => projectRow(p, { stats: stats.get(p.id) || blank(), created_by_name: names.get(p.created_by) || null, can_edit: canEditProject(user, p) })),
  };
});

// Anyone signed in can start a project; they can then edit it.
route('POST', '/api/projects', async ({ user, body }) => {
  const name = cleanStr(body.name, 120);
  need(name, 400, 'Give the project a name.');
  const classes = cleanClasses(body.classes);
  need(classes, 400, 'Add at least one class.');
  const id = crypto.randomUUID();
  await db.run(`INSERT INTO projects(id, name, description, classes, created_by, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)`,
    id, name, cleanStr(body.description, 2000), JSON.stringify(classes), user.id, iso(), now());
  return { project: projectRow(await projectById(id)) };
});

route('PATCH', '/api/projects/:id', async ({ user, body, params }) => {
  const p = await projectById(params.id);
  need(p, 404, 'No such project.');
  need(canEditProject(user, p), 403, 'Only the person who created this project, a manager or an admin can edit it.');
  const name = body.name !== undefined ? cleanStr(body.name, 120) : p.name;
  need(name, 400, 'Give the project a name.');
  const classes = body.classes !== undefined ? cleanClasses(body.classes) : JSON.parse(p.classes);
  need(classes, 400, 'Add at least one class.');
  const description = body.description !== undefined ? cleanStr(body.description, 2000) : p.description;
  const archived = body.archived !== undefined ? (body.archived ? 1 : 0) : p.archived;
  await db.run(`UPDATE projects SET name = ?, description = ?, classes = ?, archived = ?, updated_at = ? WHERE id = ?`,
    name, description, JSON.stringify(classes), archived, now(), p.id);
  return { project: projectRow(await projectById(p.id)) };
});

const finite = v => typeof v === 'number' && Number.isFinite(v);
function validPoint(pt) {
  return pt && typeof pt.id === 'string' && pt.id.length <= 64 && finite(pt.updated_at)
    && (pt.deleted || (finite(pt.lat) && finite(pt.lon) && Math.abs(pt.lat) <= 90 && Math.abs(pt.lon) <= 180));
}

// Two-way sync for one project. The client pushes its unsynced points and datasets,
// then receives everything that changed on the server since its last sync sequence number.
route('POST', '/api/projects/:id/sync', async ({ user, body, params }) => {
  const p = await projectById(params.id);
  need(p, 404, 'This project no longer exists on the server.');
  const since = Number(body.since) || 0;
  const accepted = [], rejected = [];
  const canManage = user.role !== 'collector';

  await db.tx(async t => {
    for (const ds of Array.isArray(body.datasets) ? body.datasets : []) {
      if (!ds || typeof ds.id !== 'string' || ds.id.length > 64 || !finite(ds.updated_at)) { rejected.push({ id: ds && ds.id, why: 'invalid' }); continue; }
      const cur = await t.get(`SELECT project_id, updated_at, user_id FROM datasets WHERE id = ?`, ds.id);
      if (cur && cur.project_id !== p.id) { rejected.push({ id: ds.id, why: 'wrong project' }); continue; }
      if (cur && cur.user_id !== user.id && !canManage) { rejected.push({ id: ds.id, why: 'Only the uploader or a manager can change this dataset' }); continue; }
      if (cur && cur.updated_at >= ds.updated_at) { accepted.push(ds.id); continue; }
      const clean = { ...ds }; delete clean.dirty;
      clean.targets = Array.isArray(ds.targets) ? ds.targets.filter(x => x && finite(x.lat) && finite(x.lon)).slice(0, 50000) : [];
      await t.run(`INSERT INTO datasets(id, project_id, data, deleted, updated_at, seq, user_id) VALUES(?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET data = excluded.data, deleted = excluded.deleted, updated_at = excluded.updated_at, seq = excluded.seq`,
        ds.id, p.id, JSON.stringify(clean), ds.deleted ? 1 : 0, ds.updated_at, await nextSeq(t), cur ? cur.user_id : user.id);
      accepted.push(ds.id);
    }
    for (const pt of Array.isArray(body.points) ? body.points : []) {
      if (!validPoint(pt)) { rejected.push({ id: pt && pt.id, why: 'invalid' }); continue; }
      const cur = await t.get(`SELECT project_id, updated_at, user_id FROM points WHERE id = ?`, pt.id);
      if (cur && cur.project_id !== p.id) { rejected.push({ id: pt.id, why: 'wrong project' }); continue; }
      if (cur && cur.user_id !== user.id && !canManage) { rejected.push({ id: pt.id, why: 'Only the collector or a manager can change this point' }); continue; }
      if (cur && cur.updated_at >= pt.updated_at) { accepted.push(pt.id); continue; }
      const clean = { ...pt, project_id: p.id }; delete clean.dirty;
      if (!cur) { clean.observer_id = user.id; clean.observer = clean.observer || user.name; }
      await t.run(`INSERT INTO points(id, project_id, data, deleted, updated_at, seq, user_id) VALUES(?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET data = excluded.data, deleted = excluded.deleted, updated_at = excluded.updated_at, seq = excluded.seq`,
        pt.id, p.id, JSON.stringify(clean), pt.deleted ? 1 : 0, pt.updated_at, await nextSeq(t), cur ? cur.user_id : user.id);
      accepted.push(pt.id);
    }
  });

  // Read the counter first and send only changes up to it: every change numbered at or below it has
  // already committed, so the client's next "since" can never jump past one that is still being written.
  const seq = Number((await db.get(`SELECT v FROM meta WHERE k = 'seq'`))?.v || 0);
  const points = (await db.all(`SELECT data FROM points WHERE project_id = ? AND seq > ? AND seq <= ? ORDER BY seq`, p.id, since, seq)).map(r => JSON.parse(r.data));
  const datasets = (await db.all(`SELECT data FROM datasets WHERE project_id = ? AND seq > ? AND seq <= ? ORDER BY seq`, p.id, since, seq)).map(r => JSON.parse(r.data));
  return { seq, accepted, rejected, points, datasets, project: projectRow(p) };
});

// ---------- static files ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.csv': 'text/csv; charset=utf-8', '.geojson': 'application/geo+json',
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  // send only our origin (no paths) to other sites; OSM's tile servers require a Referer from web apps
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self' https://overpass-api.de https://overpass.private.coffee https://maps.mail.ru https://overpass.kumi.systems https://routing.openstreetmap.de; worker-src 'self'; frame-ancestors 'none'",
  'Permissions-Policy': 'geolocation=(self), camera=(self)',
};

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel.startsWith('/samples/')) {
    const f = path.join(ROOT, path.normalize(rel));
    if (f.startsWith(path.join(ROOT, 'samples') + path.sep) && fs.existsSync(f)) return sendFile(res, f);
  }
  const file = path.join(PUBLIC, path.normalize(rel));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    sendFile(res, file);
  });
}
function sendFile(res, file) {
  const headers = { ...SECURITY_HEADERS };
  // the service worker fetches and caches map tiles from the tile servers
  if (path.basename(file) === 'sw.js') headers['Content-Security-Policy'] = headers['Content-Security-Policy'].replace(/connect-src [^;]*;/, "connect-src 'self' https:;");
  res.writeHead(200, { ...headers, 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, url.pathname);
  }
  const cookies = [];
  const send = (status, obj) => {
    const h = { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
    if (cookies.length) h['Set-Cookie'] = cookies;
    res.writeHead(status, h);
    res.end(JSON.stringify(obj));
  };
  try {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      // Other sites cannot add a custom header to a cross-site request without CORS, which this server never allows,
      // so requiring it stops them making changes with the visitor's cookie. Bearer requests carry no cookie risk.
      if (req.method !== 'GET' && !req.headers.authorization) need(req.headers['x-addy'] === '1', 403, 'Request refused. Reload the page and try again.');
      const auth = await authUser(req);
      const user = auth && auth.user;
      if (!r.opts.public && !user) throw new HttpError(401, 'Please sign in again.');
      if (auth && auth.via === 'bearer') cookies.push(sessionCookie(req, auth.token, true));
      const body = req.method === 'GET' ? {} : await readBody(req);
      return send(200, await r.fn({ req, body, user, params: m.groups || {}, query: url.searchParams, setCookie: c => cookies.push(c) }));
    }
    send(404, { error: 'Unknown API route' });
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    send(e.status || 500, { error: e instanceof HttpError ? e.message : 'Server error' });
  }
}

function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
}

http.createServer(handler).listen(PORT, '0.0.0.0', () => {
  console.log(`\nAddy ${VERSION}`);
  console.log(`  On this computer:  http://localhost:${PORT}`);
  for (const ip of lanAddresses()) console.log(`  On your network:   http://${ip}:${PORT}`);
  console.log(`  Data is stored in: ${db.describe}`);
});

// Phones only allow GPS on https:// (or localhost). If certs/key.pem and certs/cert.pem exist, also serve HTTPS.
const keyFile = path.join(ROOT, 'certs', 'key.pem'), certFile = path.join(ROOT, 'certs', 'cert.pem');
if (fs.existsSync(keyFile) && fs.existsSync(certFile)) {
  https.createServer({ key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }, handler).listen(HTTPS_PORT, '0.0.0.0', () => {
    for (const ip of ['localhost', ...lanAddresses()]) console.log(`  HTTPS (phones):    https://${ip}:${HTTPS_PORT}`);
  });
} else {
  console.log(`  Tip: phones need HTTPS for GPS. Run "npm run cert" once, then restart, to serve https:// on port ${HTTPS_PORT}.`);
}

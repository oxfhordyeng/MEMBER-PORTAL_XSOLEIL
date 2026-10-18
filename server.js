const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite');

const scrypt = promisify(crypto.scrypt);
const ROOT = __dirname;
const DATA_DIR = path.resolve(process.env.PORTAL_DATA_DIR || path.join(ROOT, 'data'));
const BACKUP_DIR = path.resolve(process.env.PORTAL_BACKUP_DIR || path.join(ROOT, 'backups'));
const DATABASE_PATH = path.join(DATA_DIR, 'portal.sqlite');
const PORT = Number(process.env.PORT || 3000);
const CODESPACE_ORIGINS = process.env.CODESPACE_NAME && process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN
  ? [
      `https://${process.env.CODESPACE_NAME}-${PORT}.${process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}`,
  `https://${process.env.CODESPACE_NAME}-${PORT}.preview.${process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}`,
  `https://${PORT}-${process.env.CODESPACE_NAME}.githubpreview.dev`,
      `https://${process.env.CODESPACE_NAME}-${PORT}.githubpreview.dev`,
      `http://localhost:${PORT}`,
      `http://127.0.0.1:${PORT}`
    ]
  : [];
const PUBLIC_ORIGINS = new Set(
  [
    ...(process.env.PUBLIC_ORIGIN || '').split(','),
    ...CODESPACE_ORIGINS
  ].map((origin) => origin.trim()).filter(Boolean).map((origin) => new URL(origin).origin)
);
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const PASSWORD_BYTES = 64;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const FOUNDER_CODE = 'XSOL-0004-EVER';
const LEGACY_FOUNDER_CODES = ['XSOL-0000-000'];
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_ATTEMPT_LIMIT = 10;
const loginAttempts = new Map();

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });
fs.chmodSync(DATA_DIR, 0o700);
fs.chmodSync(BACKUP_DIR, 0o700);

function openDatabase(databasePath = DATABASE_PATH, options = {}) {
  const database = new DatabaseSync(databasePath, options);
  database.exec('PRAGMA foreign_keys = ON;');
  if (!options.readOnly) database.exec('PRAGMA journal_mode = WAL;');
  return database;
}

function initializeDatabase(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
      status TEXT NOT NULL DEFAULT 'Active',
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_checkin TEXT,
      points INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_code TEXT NOT NULL REFERENCES users(code) ON DELETE CASCADE ON UPDATE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS announcements (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      starts_at TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS event_rsvps (
      event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      user_code TEXT NOT NULL REFERENCES users(code) ON DELETE CASCADE ON UPDATE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (event_id, user_code)
    );
    CREATE TABLE IF NOT EXISTS event_attendance (
      event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      user_code TEXT NOT NULL REFERENCES users(code) ON DELETE CASCADE ON UPDATE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (event_id, user_code)
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      user_code TEXT NOT NULL REFERENCES users(code) ON DELETE CASCADE ON UPDATE CASCADE,
      text TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS checkins (
      id TEXT PRIMARY KEY,
      user_code TEXT NOT NULL REFERENCES users(code) ON DELETE CASCADE ON UPDATE CASCADE,
      note TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS activity (
      id TEXT PRIMARY KEY,
      user_code TEXT NOT NULL REFERENCES users(code) ON DELETE CASCADE ON UPDATE CASCADE,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS discipline (
      id TEXT PRIMARY KEY,
      member_code TEXT NOT NULL REFERENCES users(code) ON DELETE CASCADE ON UPDATE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('Warning', 'Violation')),
      details TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Open' CHECK (status IN ('Open', 'Resolved')),
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL REFERENCES users(code)
    );
    CREATE TABLE IF NOT EXISTS admin_activity (
      id TEXT PRIMARY KEY,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS point_transactions (
      id TEXT PRIMARY KEY,
      member_code TEXT NOT NULL REFERENCES users(code) ON DELETE CASCADE ON UPDATE CASCADE,
      admin_code TEXT NOT NULL REFERENCES users(code),
      delta INTEGER NOT NULL,
      balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tasks_by_member ON tasks(user_code, created_at DESC);
    CREATE INDEX IF NOT EXISTS activity_by_member ON activity(user_code, created_at DESC);
    CREATE INDEX IF NOT EXISTS checkins_by_member ON checkins(user_code, created_at DESC);
    CREATE INDEX IF NOT EXISTS discipline_by_member ON discipline(member_code, created_at DESC);
    CREATE INDEX IF NOT EXISTS points_by_member ON point_transactions(member_code, created_at DESC);
    CREATE INDEX IF NOT EXISTS sessions_by_expiry ON sessions(expires_at);
  `);
}

const db = openDatabase();
if (fs.existsSync(DATABASE_PATH)) fs.chmodSync(DATABASE_PATH, 0o600);
initializeDatabase(db);
if (!db.prepare('PRAGMA table_info(users)').all().some((column) => column.name === 'points')) {
  db.exec('ALTER TABLE users ADD COLUMN points INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0)');
}

function ensureFounderAccount() {
  const existing = db.prepare('SELECT role FROM users WHERE code = ?').get(FOUNDER_CODE);
  if (existing) {
    if (existing.role !== 'admin') throw new Error('Founder code is assigned to a non-administrator account.');
    return;
  }

  const legacyFounder = LEGACY_FOUNDER_CODES
    .map((code) => ({ code, user: db.prepare('SELECT role FROM users WHERE code = ?').get(code) }))
    .find((entry) => entry.user);

  if (legacyFounder) {
    if (legacyFounder.user.role !== 'admin') throw new Error('Legacy founder code is assigned to a non-administrator account.');
    withTransaction(() => {
      db.exec('PRAGMA defer_foreign_keys = ON');
      db.prepare('DELETE FROM sessions WHERE user_code = ?').run(legacyFounder.code);
      db.prepare('UPDATE point_transactions SET admin_code = ? WHERE admin_code = ?').run(FOUNDER_CODE, legacyFounder.code);
      db.prepare('UPDATE users SET code = ? WHERE code = ?').run(FOUNDER_CODE, legacyFounder.code);
      db.prepare('UPDATE discipline SET created_by = ? WHERE created_by = ?').run(FOUNDER_CODE, legacyFounder.code);
    });
    return;
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.randomBytes(PASSWORD_BYTES).toString('hex');
  db.prepare('INSERT INTO users (code, name, role, status, password_salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(FOUNDER_CODE, 'Xenoford', 'admin', 'Active', salt, hash, new Date().toISOString());
}

ensureFounderAccount();

function createId() {
  return crypto.randomUUID();
}

function normalizeCode(value) {
  const code = String(value || '').trim().toUpperCase().replace(/\s+/g, '');
  return code.startsWith('XSOL-') ? code : `XSOL-${code}`;
}

function validMemberCode(code) {
  return /^XSOL-\d{4}-\d{3}$/.test(code) && code !== FOUNDER_CODE;
}

function validPassword(password) {
  return typeof password === 'string' && password.length >= 12 && password.length <= 128;
}

async function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = await scrypt(password, salt, PASSWORD_BYTES, SCRYPT_OPTIONS);
  return { salt, hash: derived.toString('hex') };
}

async function verifyPassword(password, salt, expectedHex) {
  const derived = await scrypt(password, salt, PASSWORD_BYTES, SCRYPT_OPTIONS);
  const expected = Buffer.from(expectedHex, 'hex');
  return expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
}

function sendJson(response, status, payload, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    ...(process.env.NODE_ENV === 'production' ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
    ...headers
  });
  response.end(JSON.stringify(payload));
}

function sendError(response, status, message) {
  sendJson(response, status, { error: message });
}

async function readJson(request, maxBytes = 32 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('Request body too large.'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Request body must be valid JSON.'), { status: 400 });
  }
}

function cookieValue(request, name) {
  const cookieHeader = request.headers.cookie || '';
  for (const entry of cookieHeader.split(';')) {
    const [key, ...value] = entry.trim().split('=');
    if (key === name) return value.join('=');
  }
  return '';
}

function sessionCookie(token, maxAge) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `xys_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

function sessionFor(request) {
  const token = cookieValue(request, 'xys_session');
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) return null;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const row = db.prepare(`
    SELECT users.code, users.name, users.role, users.status, users.last_checkin, users.points, sessions.expires_at
    FROM sessions JOIN users ON users.code = sessions.user_code
    WHERE sessions.token_hash = ?
  `).get(tokenHash);
  if (!row || row.expires_at <= Date.now() || row.status !== 'Active') {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    return null;
  }
  return row;
}

function requireUser(request, response, role) {
  const user = sessionFor(request);
  if (!user) {
    sendError(response, 401, 'Sign in to continue.');
    return null;
  }
  if (role && user.role !== role) {
    sendError(response, 403, 'This action is not available for your account.');
    return null;
  }
  return user;
}

function recordActivity(userCode, message) {
  db.prepare('INSERT INTO activity (id, user_code, message, created_at) VALUES (?, ?, ?, ?)')
    .run(createId(), userCode, message, new Date().toISOString());
}

function recordAdminActivity(message) {
  db.prepare('INSERT INTO admin_activity (id, message, created_at) VALUES (?, ?, ?)')
    .run(createId(), message, new Date().toISOString());
  db.prepare(`
    DELETE FROM admin_activity WHERE id IN (
      SELECT id FROM admin_activity ORDER BY created_at DESC LIMIT -1 OFFSET 100
    )
  `).run();
}

function buildState(user) {
  const events = db.prepare('SELECT * FROM events ORDER BY starts_at').all()
    .filter((event) => Date.parse(event.starts_at) >= Date.now() - 86400000)
    .map((event) => ({
      id: event.id,
      title: event.title,
      startsAt: event.starts_at,
      details: event.details,
      rsvped: Boolean(db.prepare('SELECT 1 FROM event_rsvps WHERE event_id = ? AND user_code = ?').get(event.id, user.code)),
      attended: Boolean(db.prepare('SELECT 1 FROM event_attendance WHERE event_id = ? AND user_code = ?').get(event.id, user.code)),
      rsvpCount: db.prepare('SELECT COUNT(*) AS count FROM event_rsvps WHERE event_id = ?').get(event.id).count,
      attendeeCount: db.prepare('SELECT COUNT(*) AS count FROM event_attendance WHERE event_id = ?').get(event.id).count
    }));

  const state = {
    user: {
      code: user.role === 'admin' ? undefined : user.code,
      name: user.name,
      role: user.role,
      status: user.status,
      lastCheckIn: user.last_checkin,
      points: user.points || 0
    },
    announcements: db.prepare('SELECT id, title, body, created_at AS createdAt FROM announcements ORDER BY created_at DESC').all(),
    events,
    tasks: db.prepare('SELECT id, text, done, created_at AS createdAt FROM tasks WHERE user_code = ? ORDER BY created_at DESC').all(user.code)
      .map((task) => ({ ...task, done: Boolean(task.done) })),
    activity: db.prepare('SELECT id, message, created_at AS createdAt FROM activity WHERE user_code = ? ORDER BY created_at DESC LIMIT 40').all(user.code),
    checkins: db.prepare('SELECT id, note, created_at AS createdAt FROM checkins WHERE user_code = ? ORDER BY created_at DESC LIMIT 10').all(user.code),
    pointHistory: user.role === 'member'
      ? db.prepare('SELECT id, delta, balance_after AS balanceAfter, reason, created_at AS createdAt FROM point_transactions WHERE member_code = ? ORDER BY created_at DESC LIMIT 30').all(user.code)
      : [],
    notices: user.role === 'member'
      ? db.prepare('SELECT id, type, details, status, created_at AS createdAt FROM discipline WHERE member_code = ? ORDER BY created_at DESC').all(user.code)
      : []
  };

  if (user.role === 'admin') {
    state.members = db.prepare('SELECT code, name, status, last_checkin AS lastCheckIn, points FROM users WHERE role = ? ORDER BY name').all('member');
    state.pointHistory = db.prepare(`
      SELECT point_transactions.id, point_transactions.member_code AS memberCode,
        users.name AS memberName, point_transactions.delta,
        point_transactions.balance_after AS balanceAfter, point_transactions.reason,
        point_transactions.created_at AS createdAt
      FROM point_transactions JOIN users ON users.code = point_transactions.member_code
      ORDER BY point_transactions.created_at DESC LIMIT 100
    `).all();
    state.adminActivity = db.prepare('SELECT id, message, created_at AS createdAt FROM admin_activity ORDER BY created_at DESC LIMIT 100').all();
    state.notices = db.prepare(`
      SELECT discipline.id, discipline.member_code AS memberCode, users.name AS memberName,
        discipline.type, discipline.details, discipline.status, discipline.created_at AS createdAt
      FROM discipline JOIN users ON users.code = discipline.member_code
      ORDER BY discipline.created_at DESC
    `).all();
  }
  return state;
}

function updatePassword(userCode, credentials) {
  db.prepare('UPDATE users SET password_salt = ?, password_hash = ? WHERE code = ?')
    .run(credentials.salt, credentials.hash, userCode);
}

function withTransaction(action) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function validateSameOrigin(request, response) {
  const origin = request.headers.origin;
  if (!origin) {
    sendError(response, 403, 'A same-origin request is required.');
    return false;
  }
  try {
    const requestOrigin = new URL(origin).origin;
    const isSameOriginBrowserRequest = ['same-origin', 'same-site'].includes(request.headers['sec-fetch-site'])
      && request.headers.referer
      && new URL(request.headers.referer).origin === requestOrigin;
    if (PUBLIC_ORIGINS.size) {
      if (PUBLIC_ORIGINS.has(requestOrigin) || isSameOriginBrowserRequest) return true;
      sendError(response, 403, `Request origin was not accepted from ${new URL(origin).host}.`);
      return false;
    }
    if (isSameOriginBrowserRequest) return true;
    const forwardedProto = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const scheme = forwardedProto === 'https' || request.socket.encrypted ? 'https:' : 'http:';
    if (requestOrigin === `${scheme}//${request.headers.host}`) return true;
  } catch {
    // Reject malformed origin headers below.
  }
  sendError(response, 403, 'Request origin was not accepted.');
  return false;
}

function checkLoginRateLimit(request, code) {
  const address = request.socket.remoteAddress || 'unknown';
  const bucket = `${address}:${code}`;
  const now = Date.now();
  if (loginAttempts.size > 10000) {
    for (const [key, attempts] of loginAttempts) {
      if (!attempts.some((time) => now - time < LOGIN_WINDOW_MS)) loginAttempts.delete(key);
      if (loginAttempts.size <= 9000) break;
    }
  }
  const recent = (loginAttempts.get(bucket) || []).filter((time) => now - time < LOGIN_WINDOW_MS);
  if (recent.length >= LOGIN_ATTEMPT_LIMIT) {
    loginAttempts.set(bucket, recent);
    return false;
  }
  recent.push(now);
  loginAttempts.set(bucket, recent);
  return true;
}

function backupFilename() {
  return `portal-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}.sqlite`;
}

function createBackup() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const filename = backupFilename();
  const destination = path.join(BACKUP_DIR, filename).replace(/'/g, "''");
  db.exec(`VACUUM INTO '${destination}'`);
  fs.chmodSync(path.join(BACKUP_DIR, filename), 0o600);
  const configuredRetention = Number(process.env.BACKUP_RETENTION_DAYS || 30);
  const retentionDays = Number.isFinite(configuredRetention) ? Math.min(3650, Math.max(1, configuredRetention)) : 30;
  const cutoff = Date.now() - retentionDays * 86400000;
  fs.readdirSync(BACKUP_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^portal-.*\.sqlite$/.test(entry.name))
    .forEach((entry) => {
      const fullPath = path.join(BACKUP_DIR, entry.name);
      if (fs.statSync(fullPath).mtimeMs < cutoff) fs.unlinkSync(fullPath);
    });
  return path.join(BACKUP_DIR, filename);
}

function sendFile(response, filename, downloadName) {
  const stat = fs.statSync(filename);
  response.writeHead(200, {
    'Content-Type': 'application/vnd.sqlite3',
    'Content-Length': stat.size,
    'Content-Disposition': `attachment; filename="${downloadName}"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    ...(process.env.NODE_ENV === 'production' ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {})
  });
  fs.createReadStream(filename).pipe(response);
}

function sendStatic(request, response, pathname) {
  const name = pathname === '/' ? 'index.html' : pathname.slice(1);
  const allowedFiles = new Set(['index.html', 'styles.css', 'app.js']);
  if (!allowedFiles.has(name)) return sendError(response, 404, 'Not found.');
  const contentTypes = {
    'index.html': 'text/html; charset=utf-8',
    'styles.css': 'text/css; charset=utf-8',
    'app.js': 'text/javascript; charset=utf-8'
  };
  const filename = path.join(ROOT, name);
  response.writeHead(200, {
    'Content-Type': contentTypes[name],
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
  });
  if (request.method === 'HEAD') return response.end();
  fs.createReadStream(filename).pipe(response);
}

async function handleApi(request, response, url) {
  if (request.method === 'POST' || request.method === 'PATCH' || request.method === 'DELETE') {
    if (!validateSameOrigin(request, response)) return;
  }

  if (request.method === 'POST' && url.pathname === '/api/login') {
    const body = await readJson(request);
    const code = normalizeCode(body.code);
    if (!checkLoginRateLimit(request, code)) return sendError(response, 429, 'Too many sign-in attempts for this account. Try again in 15 minutes.');
    if (!['admin', 'member'].includes(body.role)) return sendError(response, 400, 'Choose Member or Administrator sign-in.');
    const user = db.prepare('SELECT * FROM users WHERE code = ?').get(code);
    if (!user) {
      await hashPassword(String(body.password || ''), 'xys-invalid-user-salt');
      return sendError(response, 401, 'Access code or password was not recognized.');
    }
    if (user.status === 'Reset required') return sendError(response, 403, 'Your account needs a new password. Contact the founder.');
    if (user.status !== 'Active' || user.role !== body.role) {
      return sendError(response, 401, 'Access code or password was not recognized.');
    }
    if (user.role === 'member' && !(await verifyPassword(String(body.password || ''), user.password_salt, user.password_hash))) {
      return sendError(response, 401, 'Access code or password was not recognized.');
    }

    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = Date.now() + SESSION_TTL_MS;
    db.prepare('INSERT INTO sessions (token_hash, user_code, expires_at) VALUES (?, ?, ?)')
      .run(tokenHash, user.code, expiresAt);
    if (user.role === 'admin') recordAdminActivity('Administrator signed in');
    else recordActivity(user.code, 'Member signed in');
    return sendJson(response, 200, { ok: true, state: buildState({ ...user, expires_at: expiresAt }) }, {
      'Set-Cookie': sessionCookie(token, Math.floor(SESSION_TTL_MS / 1000))
    });
  }

  if (request.method === 'POST' && url.pathname === '/api/logout') {
    const token = cookieValue(request, 'xys_session');
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(crypto.createHash('sha256').update(token).digest('hex'));
    return sendJson(response, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
  }

  if (request.method === 'GET' && url.pathname === '/api/state') {
    const user = requireUser(request, response);
    if (!user) return;
    return sendJson(response, 200, { state: buildState(user) });
  }

  if (request.method === 'POST' && url.pathname === '/api/password') {
    const user = requireUser(request, response, 'member');
    if (!user) return;
    const body = await readJson(request);
    if (!validPassword(body.newPassword)) return sendError(response, 400, 'Use a password with at least 12 characters.');
    const stored = db.prepare('SELECT password_salt, password_hash FROM users WHERE code = ?').get(user.code);
    if (!(await verifyPassword(String(body.currentPassword || ''), stored.password_salt, stored.password_hash))) {
      return sendError(response, 400, 'Current password was not accepted.');
    }
    updatePassword(user.code, await hashPassword(body.newPassword));
    recordActivity(user.code, 'Changed account password');
    return sendJson(response, 200, { ok: true });
  }

  if (request.method === 'POST' && url.pathname === '/api/tasks') {
    const user = requireUser(request, response, 'member');
    if (!user) return;
    const body = await readJson(request);
    const text = String(body.text || '').trim();
    if (!text || text.length > 100) return sendError(response, 400, 'Task must be between 1 and 100 characters.');
    const id = createId();
    db.prepare('INSERT INTO tasks (id, user_code, text, done, created_at) VALUES (?, ?, ?, 0, ?)')
      .run(id, user.code, text, new Date().toISOString());
    recordActivity(user.code, `Added task: ${text}`);
    return sendJson(response, 201, { ok: true, id });
  }

  const taskMatch = url.pathname.match(/^\/api\/tasks\/([\w-]+)$/);
  if (taskMatch && request.method === 'PATCH') {
    const user = requireUser(request, response, 'member');
    if (!user) return;
    const body = await readJson(request);
    const task = db.prepare('SELECT id, text, done FROM tasks WHERE id = ? AND user_code = ?').get(taskMatch[1], user.code);
    if (!task) return sendError(response, 404, 'Task not found.');
    if (typeof body.done !== 'boolean') return sendError(response, 400, 'Task completion must be true or false.');
    db.prepare('UPDATE tasks SET done = ? WHERE id = ? AND user_code = ?').run(Number(body.done), task.id, user.code);
    recordActivity(user.code, `${body.done ? 'Completed' : 'Reopened'} task: ${task.text}`);
    return sendJson(response, 200, { ok: true });
  }
  if (taskMatch && request.method === 'DELETE') {
    const user = requireUser(request, response, 'member');
    if (!user) return;
    const task = db.prepare('SELECT text FROM tasks WHERE id = ? AND user_code = ?').get(taskMatch[1], user.code);
    if (!task) return sendError(response, 404, 'Task not found.');
    db.prepare('DELETE FROM tasks WHERE id = ? AND user_code = ?').run(taskMatch[1], user.code);
    recordActivity(user.code, `Removed task: ${task.text}`);
    return sendJson(response, 200, { ok: true });
  }

  if (request.method === 'POST' && url.pathname === '/api/checkins') {
    const user = requireUser(request, response, 'member');
    if (!user) return;
    const body = await readJson(request);
    const note = String(body.note || '').trim();
    if (!note || note.length > 120) return sendError(response, 400, 'Check-in note must be between 1 and 120 characters.');
    const createdAt = new Date().toISOString();
    withTransaction(() => {
      db.prepare('INSERT INTO checkins (id, user_code, note, created_at) VALUES (?, ?, ?, ?)').run(createId(), user.code, note, createdAt);
      db.prepare('UPDATE users SET last_checkin = ? WHERE code = ?').run(createdAt, user.code);
      db.prepare('INSERT INTO activity (id, user_code, message, created_at) VALUES (?, ?, ?, ?)').run(createId(), user.code, `Checked in: ${note}`, createdAt);
    });
    return sendJson(response, 201, { ok: true, createdAt });
  }

  const eventActionMatch = url.pathname.match(/^\/api\/events\/([\w-]+)\/(rsvp|attendance)$/);
  if (eventActionMatch && request.method === 'POST') {
    const user = requireUser(request, response, 'member');
    if (!user) return;
    const [, eventId, action] = eventActionMatch;
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!event) return sendError(response, 404, 'Event not found.');
    if (action === 'rsvp') {
      const existing = db.prepare('SELECT 1 FROM event_rsvps WHERE event_id = ? AND user_code = ?').get(eventId, user.code);
      if (existing) {
        db.prepare('DELETE FROM event_rsvps WHERE event_id = ? AND user_code = ?').run(eventId, user.code);
        recordActivity(user.code, `Cancelled RSVP: ${event.title}`);
        return sendJson(response, 200, { ok: true, rsvped: false });
      }
      db.prepare('INSERT INTO event_rsvps (event_id, user_code, created_at) VALUES (?, ?, ?)').run(eventId, user.code, new Date().toISOString());
      recordActivity(user.code, `RSVPed to: ${event.title}`);
      return sendJson(response, 200, { ok: true, rsvped: true });
    }
    if (Date.parse(event.starts_at) > Date.now()) return sendError(response, 400, 'Attendance can be confirmed after the event starts.');
    if (!db.prepare('SELECT 1 FROM event_rsvps WHERE event_id = ? AND user_code = ?').get(eventId, user.code)) {
      return sendError(response, 403, 'RSVP before confirming attendance.');
    }
    const createdAt = new Date().toISOString();
    withTransaction(() => {
      db.prepare('INSERT OR IGNORE INTO event_attendance (event_id, user_code, created_at) VALUES (?, ?, ?)').run(eventId, user.code, createdAt);
      db.prepare('INSERT INTO checkins (id, user_code, note, created_at) VALUES (?, ?, ?, ?)').run(createId(), user.code, `Event attendance: ${event.title}`, createdAt);
      db.prepare('UPDATE users SET last_checkin = ? WHERE code = ?').run(createdAt, user.code);
      db.prepare('INSERT INTO activity (id, user_code, message, created_at) VALUES (?, ?, ?, ?)').run(createId(), user.code, `Attended event: ${event.title}`, createdAt);
    });
    return sendJson(response, 200, { ok: true, attended: true });
  }

  if (request.method === 'POST' && url.pathname === '/api/admin/members') {
    const admin = requireUser(request, response, 'admin');
    if (!admin) return;
    const body = await readJson(request);
    const code = normalizeCode(body.code);
    const name = String(body.name || '').trim();
    if (!validMemberCode(code)) return sendError(response, 400, 'Use a member code in the format XSOL-0000-001.');
    if (!name || name.length > 60) return sendError(response, 400, 'Member name must be between 1 and 60 characters.');
    if (!validPassword(body.password)) return sendError(response, 400, 'Set a temporary password with at least 12 characters.');
    if (db.prepare('SELECT 1 FROM users WHERE code = ?').get(code)) return sendError(response, 409, 'That member code is already assigned.');
    const credentials = await hashPassword(body.password);
    db.prepare('INSERT INTO users (code, name, role, status, password_salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(code, name, 'member', 'Active', credentials.salt, credentials.hash, new Date().toISOString());
    recordAdminActivity(`Added member: ${name} (${code})`);
    return sendJson(response, 201, { ok: true });
  }

  const pointsMatch = url.pathname.match(/^\/api\/admin\/members\/([^/]+)\/points$/);
  if (pointsMatch && request.method === 'POST') {
    const admin = requireUser(request, response, 'admin');
    if (!admin) return;
    const memberCode = decodeURIComponent(pointsMatch[1]);
    const body = await readJson(request);
    const delta = body.delta;
    const reason = String(body.reason || '').trim();
    if (!Number.isSafeInteger(delta) || delta === 0 || Math.abs(delta) > 100000) {
      return sendError(response, 400, 'Enter a whole-point adjustment between -100,000 and 100,000.');
    }
    if (reason.length < 3 || reason.length > 200) {
      return sendError(response, 400, 'Add a reason between 3 and 200 characters.');
    }

    const member = db.prepare('SELECT name, points FROM users WHERE code = ? AND role = ?').get(memberCode, 'member');
    if (!member) return sendError(response, 404, 'Member not found.');
    const balanceAfter = member.points + delta;
    if (balanceAfter < 0) return sendError(response, 400, 'This adjustment would make the member balance negative.');

    const createdAt = new Date().toISOString();
    withTransaction(() => {
      db.prepare('UPDATE users SET points = ? WHERE code = ?').run(balanceAfter, memberCode);
      db.prepare(`
        INSERT INTO point_transactions (id, member_code, admin_code, delta, balance_after, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(createId(), memberCode, admin.code, delta, balanceAfter, reason, createdAt);
      recordAdminActivity(`${delta > 0 ? 'Awarded' : 'Deducted'} ${Math.abs(delta)} points ${delta > 0 ? 'to' : 'from'} ${member.name}: ${reason}`);
    });
    return sendJson(response, 200, { ok: true, points: balanceAfter });
  }

  const memberStatusMatch = url.pathname.match(/^\/api\/admin\/members\/([^/]+)\/status$/);
  if (memberStatusMatch && request.method === 'PATCH') {
    const admin = requireUser(request, response, 'admin');
    if (!admin) return;
    const code = decodeURIComponent(memberStatusMatch[1]);
    const body = await readJson(request);
    if (!['Active', 'Suspended'].includes(body.status)) return sendError(response, 400, 'Choose Active or Suspended.');
    const member = db.prepare('SELECT name FROM users WHERE code = ? AND role = ?').get(code, 'member');
    if (!member) return sendError(response, 404, 'Member not found.');
    db.prepare('UPDATE users SET status = ? WHERE code = ?').run(body.status, code);
    db.prepare('DELETE FROM sessions WHERE user_code = ?').run(code);
    recordAdminActivity(`${body.status === 'Active' ? 'Reactivated' : 'Suspended'} member: ${member.name}`);
    return sendJson(response, 200, { ok: true });
  }

  if (request.method === 'POST' && url.pathname === '/api/admin/members/recover') {
    const admin = requireUser(request, response, 'admin');
    if (!admin) return;
    const body = await readJson(request);
    const oldCode = normalizeCode(body.oldCode);
    const newCode = normalizeCode(body.newCode);
    const member = db.prepare('SELECT name, status FROM users WHERE code = ? AND role = ?').get(oldCode, 'member');
    if (!member) return sendError(response, 404, 'Member not found.');
    if (!validMemberCode(newCode)) return sendError(response, 400, 'Use a replacement code in the format XSOL-0000-001.');
    if (newCode !== oldCode && db.prepare('SELECT 1 FROM users WHERE code = ?').get(newCode)) return sendError(response, 409, 'That replacement code is already assigned.');
    if (!validPassword(body.password)) return sendError(response, 400, 'Set a temporary password with at least 12 characters.');
    const credentials = await hashPassword(body.password);
    withTransaction(() => {
      db.prepare('UPDATE users SET code = ?, password_salt = ?, password_hash = ?, status = ? WHERE code = ?')
        .run(newCode, credentials.salt, credentials.hash, 'Active', oldCode);
      db.prepare('DELETE FROM sessions WHERE user_code = ?').run(newCode);
    });
    recordAdminActivity(`Recovered account for ${member.name} (${oldCode}${oldCode === newCode ? '' : ` to ${newCode}`})`);
    return sendJson(response, 200, { ok: true });
  }

  if (request.method === 'POST' && url.pathname === '/api/admin/announcements') {
    const admin = requireUser(request, response, 'admin');
    if (!admin) return;
    const body = await readJson(request);
    const title = String(body.title || '').trim();
    const message = String(body.body || '').trim();
    if (!title || title.length > 80 || !message || message.length > 500) return sendError(response, 400, 'Add a title and message within the character limits.');
    db.prepare('INSERT INTO announcements (id, title, body, created_at) VALUES (?, ?, ?, ?)')
      .run(createId(), title, message, new Date().toISOString());
    recordAdminActivity(`Published announcement: ${title}`);
    return sendJson(response, 201, { ok: true });
  }

  if (request.method === 'POST' && url.pathname === '/api/admin/events') {
    const admin = requireUser(request, response, 'admin');
    if (!admin) return;
    const body = await readJson(request);
    const title = String(body.title || '').trim();
    const startsAt = new Date(body.startsAt);
    const details = String(body.details || '').trim();
    if (!title || title.length > 80 || !Number.isFinite(startsAt.getTime()) || startsAt.getTime() <= Date.now() || details.length > 300) {
      return sendError(response, 400, 'Enter an event name, a future date, and details under 300 characters.');
    }
    const id = createId();
    db.prepare('INSERT INTO events (id, title, starts_at, details) VALUES (?, ?, ?, ?)').run(id, title, startsAt.toISOString(), details);
    recordAdminActivity(`Scheduled event: ${title}`);
    return sendJson(response, 201, { ok: true, id });
  }

  const adminEventMatch = url.pathname.match(/^\/api\/admin\/events\/([\w-]+)$/);
  if (adminEventMatch && request.method === 'DELETE') {
    const admin = requireUser(request, response, 'admin');
    if (!admin) return;
    const event = db.prepare('SELECT title FROM events WHERE id = ?').get(adminEventMatch[1]);
    if (!event) return sendError(response, 404, 'Event not found.');
    db.prepare('DELETE FROM events WHERE id = ?').run(adminEventMatch[1]);
    recordAdminActivity(`Removed event: ${event.title}`);
    return sendJson(response, 200, { ok: true });
  }

  if (request.method === 'POST' && url.pathname === '/api/admin/notices') {
    const admin = requireUser(request, response, 'admin');
    if (!admin) return;
    const body = await readJson(request);
    const memberCode = normalizeCode(body.memberCode);
    const type = body.type;
    const details = String(body.details || '').trim();
    const member = db.prepare('SELECT name FROM users WHERE code = ? AND role = ?').get(memberCode, 'member');
    if (!member) return sendError(response, 404, 'Choose a member in the directory.');
    if (!['Warning', 'Violation'].includes(type) || !details || details.length > 500) return sendError(response, 400, 'Choose a notice type and add details under 500 characters.');
    db.prepare('INSERT INTO discipline (id, member_code, type, details, status, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(createId(), memberCode, type, details, 'Open', new Date().toISOString(), admin.code);
    recordAdminActivity(`Issued ${type.toLowerCase()} to ${member.name}`);
    return sendJson(response, 201, { ok: true });
  }

  const noticeMatch = url.pathname.match(/^\/api\/admin\/notices\/([\w-]+)$/);
  if (noticeMatch && request.method === 'PATCH') {
    const admin = requireUser(request, response, 'admin');
    if (!admin) return;
    const body = await readJson(request);
    if (!['Open', 'Resolved'].includes(body.status)) return sendError(response, 400, 'Choose Open or Resolved.');
    const notice = db.prepare(`
      SELECT discipline.type, users.name FROM discipline
      JOIN users ON users.code = discipline.member_code WHERE discipline.id = ?
    `).get(noticeMatch[1]);
    if (!notice) return sendError(response, 404, 'Notice not found.');
    db.prepare('UPDATE discipline SET status = ? WHERE id = ?').run(body.status, noticeMatch[1]);
    recordAdminActivity(`${body.status} ${notice.type.toLowerCase()} for ${notice.name}`);
    return sendJson(response, 200, { ok: true });
  }

  if (request.method === 'POST' && url.pathname === '/api/admin/backup') {
    const admin = requireUser(request, response, 'admin');
    if (!admin) return;
    await readJson(request);
    recordAdminActivity('Downloaded a manual database backup');
    const filename = createBackup();
    return sendFile(response, filename, path.basename(filename));
  }

  return sendError(response, 404, 'API route not found.');
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return await handleApi(request, response, url);
    if (request.method !== 'GET' && request.method !== 'HEAD') return sendError(response, 405, 'Method not allowed.');
    return sendStatic(request, response, url.pathname);
  } catch (error) {
    console.error(error);
    if (!response.headersSent) sendError(response, error.status || 500, error.status ? error.message : 'The request could not be completed.');
    else response.destroy();
  }
});

function restoreBackup(sourcePath) {
  const source = path.resolve(sourcePath || '');
  if (!sourcePath || !fs.existsSync(source) || source === DATABASE_PATH) throw new Error('Provide an existing backup file path.');
  const backup = openDatabase(source, { readOnly: true });
  try {
    const result = backup.prepare('PRAGMA integrity_check').get();
    if (result.integrity_check !== 'ok' || !backup.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get()) {
      throw new Error('The selected file is not a valid XYSOLEIL database backup.');
    }
  } finally {
    backup.close();
  }
  createBackup();
  const stagedPath = `${DATABASE_PATH}.restore`;
  db.close();
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${DATABASE_PATH}${suffix}`;
    if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
  }
  fs.copyFileSync(source, stagedPath);
  fs.chmodSync(stagedPath, 0o600);
  fs.renameSync(stagedPath, DATABASE_PATH);
  console.log(`Restored portal database from ${source}.`);
}

async function main() {
  const command = process.argv[2];
  if (command === 'restore') {
    restoreBackup(process.argv[3]);
    return;
  }

  try {
    const backupPath = createBackup();
    console.log(`Startup snapshot saved: ${path.basename(backupPath)}`);
  } catch (error) {
    console.error(`Could not create startup backup: ${error.message}`);
  }
  const requestedBackupInterval = Number(process.env.BACKUP_INTERVAL_HOURS || 24);
  const backupInterval = Number.isFinite(requestedBackupInterval) ? Math.min(168, Math.max(1, requestedBackupInterval)) : 24;
  const backupTimer = setInterval(() => {
    try {
      const backupPath = createBackup();
      console.log(`Scheduled snapshot saved: ${path.basename(backupPath)}`);
    } catch (error) {
      console.error(`Scheduled backup failed: ${error.message}`);
    }
  }, backupInterval * 60 * 60 * 1000);
  backupTimer.unref();
  setInterval(() => {
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
    const now = Date.now();
    for (const [address, attempts] of loginAttempts) {
      const recent = attempts.filter((time) => now - time < LOGIN_WINDOW_MS);
      if (recent.length) loginAttempts.set(address, recent);
      else loginAttempts.delete(address);
    }
  }, 60 * 60 * 1000).unref();

  server.listen(PORT, process.env.HOST || '0.0.0.0', () => {
    console.log(`XYSOLEIL portal listening on http://localhost:${PORT}`);
    console.log(`Database: ${DATABASE_PATH}`);
    console.log(`Scheduled backups: every ${backupInterval} hour(s), retaining ${process.env.BACKUP_RETENTION_DAYS || 30} days in ${BACKUP_DIR}`);
  });
}

main().catch((error) => {
  console.error(error.message);
  db.close();
  process.exitCode = 1;
});
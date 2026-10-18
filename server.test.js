const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const net = require('node:net');
const { DatabaseSync } = require('node:sqlite');
const { after, before, test } = require('node:test');

const ROOT = __dirname;
const FOUNDER_CODE = 'XSOL-0004-EVER';
const LEGACY_FOUNDER_CODE = 'XSOL-0000-000';
const MEMBER_PASSWORD = 'member-integration-password-762';
let temporaryRoot;
let dataDirectory;
let backupDirectory;
let port;
let serverProcess;

async function freePort() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function serverEnvironment() {
  const forwardedOrigin = process.env.CODESPACE_NAME && process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN
    ? `https://${process.env.CODESPACE_NAME}-${port}.${process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}`
    : '';
  return {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    PORTAL_DATA_DIR: dataDirectory,
    PORTAL_BACKUP_DIR: backupDirectory,
    BACKUP_INTERVAL_HOURS: '24',
    PUBLIC_ORIGIN: [`http://127.0.0.1:${port}`, `http://localhost:${port}`, forwardedOrigin].filter(Boolean).join(',')
  };
}

function startServer() {
  serverProcess = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
    cwd: ROOT,
    env: serverEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  serverProcess.stdout.on('data', () => {});
  serverProcess.stderr.on('data', () => {});
}

async function stopServer() {
  if (!serverProcess || serverProcess.exitCode !== null) return;
  const child = serverProcess;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
  serverProcess = null;
}

async function waitForServer() {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (serverProcess?.exitCode !== null) throw new Error('Portal server exited before becoming ready.');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
  throw new Error('Portal server did not become ready.');
}

async function callApi(route, { method = 'GET', body, cookie } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: {
      ...(['POST', 'PATCH', 'DELETE'].includes(method) ? { Origin: `http://127.0.0.1:${port}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : null;
  return {
    response,
    payload,
    cookie: response.headers.get('set-cookie')?.split(';')[0]
  };
}

async function login(code, password, role) {
  return callApi('/api/login', {
    method: 'POST',
    body: { code, role, ...(password ? { password } : {}) }
  });
}

before(async () => {
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xys-portal-test-'));
  dataDirectory = path.join(temporaryRoot, 'data');
  backupDirectory = path.join(temporaryRoot, 'backups');
  port = await freePort();
  startServer();
  await waitForServer();
});

after(async () => {
  await stopServer();
  if (temporaryRoot) fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

test('secure portal supports member isolation, account recovery, durable records, and database backups', async () => {
  const unauthenticatedState = await callApi('/api/state');
  assert.equal(unauthenticatedState.response.status, 401);

  const admin = await login(FOUNDER_CODE, undefined, 'admin');
  assert.equal(admin.response.status, 200);
  const adminCookie = admin.cookie;
  assert.ok(adminCookie);
  assert.equal(admin.payload.state.user.role, 'admin');
  assert.equal(admin.payload.state.user.code, undefined);

  const localhostOrigin = `http://localhost:${port}`;
  const localhostLogin = await fetch(`http://127.0.0.1:${port}/api/login`, {
    method: 'POST',
    headers: {
      Origin: localhostOrigin,
      Referer: `${localhostOrigin}/`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ code: FOUNDER_CODE, role: 'admin' })
  });
  assert.equal(localhostLogin.status, 200);
  const localhostCookie = localhostLogin.headers.get('set-cookie')?.split(';')[0];
  await fetch(`http://127.0.0.1:${port}/api/logout`, {
    method: 'POST',
    headers: { Cookie: localhostCookie, Origin: localhostOrigin, 'Content-Type': 'application/json' },
    body: '{}'
  });

  const founderSelectedAsMember = await login(FOUNDER_CODE, undefined, 'member');
  assert.equal(founderSelectedAsMember.response.status, 401);

  const forwardedHttpsLogin = await fetch(`http://127.0.0.1:${port}/api/login`, {
    method: 'POST',
    headers: {
      Origin: process.env.CODESPACE_NAME && process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN
        ? `https://${process.env.CODESPACE_NAME}-${port}.${process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}`
        : `https://127.0.0.1:${port}`,
      'X-Forwarded-Proto': 'https',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ code: FOUNDER_CODE, role: 'admin' })
  });
  assert.equal(forwardedHttpsLogin.status, 200);
  const proxyCookie = forwardedHttpsLogin.headers.get('set-cookie')?.split(';')[0];
  await fetch(`http://127.0.0.1:${port}/api/logout`, {
    method: 'POST',
    headers: {
      Cookie: proxyCookie,
      Origin: process.env.CODESPACE_NAME && process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN
        ? `https://${process.env.CODESPACE_NAME}-${port}.${process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}`
        : `https://127.0.0.1:${port}`,
      'X-Forwarded-Proto': 'https',
      'Content-Type': 'application/json'
    },
    body: '{}'
  });

  const previewOrigin = process.env.CODESPACE_NAME && process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN
    ? `https://${process.env.CODESPACE_NAME}-${port}.preview.${process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}`
    : 'https://preview-alias.example';
  const previewAliasLogin = await fetch(`http://127.0.0.1:${port}/api/login`, {
    method: 'POST',
    headers: {
      Origin: previewOrigin,
      Referer: `${previewOrigin}/`,
      'Sec-Fetch-Site': 'same-origin',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ code: FOUNDER_CODE, role: 'admin' })
  });
  assert.equal(previewAliasLogin.status, 200);
  const aliasCookie = previewAliasLogin.headers.get('set-cookie')?.split(';')[0];
  await fetch(`http://127.0.0.1:${port}/api/logout`, {
    method: 'POST',
    headers: {
      Cookie: aliasCookie,
      Origin: previewOrigin,
      Referer: `${previewOrigin}/`,
      'Sec-Fetch-Site': 'same-origin',
      'Content-Type': 'application/json'
    },
    body: '{}'
  });

  const legacyPreviewOrigin = process.env.CODESPACE_NAME
    ? `https://${port}-${process.env.CODESPACE_NAME}.githubpreview.dev`
    : 'https://legacy-preview.example';
  const legacyPreviewLogin = await fetch(`http://127.0.0.1:${port}/api/login`, {
    method: 'POST',
    headers: {
      Origin: legacyPreviewOrigin,
      Referer: `${legacyPreviewOrigin}/`,
      'Sec-Fetch-Site': 'same-origin',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ code: FOUNDER_CODE, role: 'admin' })
  });
  assert.equal(legacyPreviewLogin.status, 200);

  const createdMember = await callApi('/api/admin/members', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      name: 'Test Member',
      code: 'XSOL-0000-001',
      password: MEMBER_PASSWORD
    }
  });
  assert.equal(createdMember.response.status, 201);
  const database = new DatabaseSync(path.join(dataDirectory, 'portal.sqlite'), { readOnly: true });
  const storedMember = database.prepare('SELECT password_hash FROM users WHERE code = ?').get('XSOL-0000-001');
  assert.ok(storedMember.password_hash);
  assert.notEqual(storedMember.password_hash, MEMBER_PASSWORD);
  database.close();

  const awardedPoints = await callApi('/api/admin/members/XSOL-0000-001/points', {
    method: 'POST',
    cookie: adminCookie,
    body: { delta: 125, reason: 'Event contribution' }
  });
  assert.equal(awardedPoints.response.status, 200);
  assert.equal(awardedPoints.payload.points, 125);

  const deductedPoints = await callApi('/api/admin/members/XSOL-0000-001/points', {
    method: 'POST',
    cookie: adminCookie,
    body: { delta: -25, reason: 'Reward redemption' }
  });
  assert.equal(deductedPoints.response.status, 200);
  assert.equal(deductedPoints.payload.points, 100);

  const excessiveDeduction = await callApi('/api/admin/members/XSOL-0000-001/points', {
    method: 'POST',
    cookie: adminCookie,
    body: { delta: -101, reason: 'Overdraw test' }
  });
  assert.equal(excessiveDeduction.response.status, 400);

  const adminPointsState = await callApi('/api/state', { cookie: adminCookie });
  assert.equal(adminPointsState.payload.state.members[0].points, 100);
  assert.equal(adminPointsState.payload.state.pointHistory.length, 2);

  const memberWithoutPassword = await login('XSOL-0000-001', undefined, 'member');
  assert.equal(memberWithoutPassword.response.status, 401);

  const member = await login('XSOL-0000-001', MEMBER_PASSWORD, 'member');
  assert.equal(member.response.status, 200);
  const memberCookie = member.cookie;
  assert.ok(memberCookie);
  assert.equal(member.payload.state.members, undefined);
  assert.equal(member.payload.state.user.role, 'member');
  assert.equal(member.payload.state.user.code, 'XSOL-0000-001');
  assert.equal(member.payload.state.user.points, 100);
  assert.equal(member.payload.state.pointHistory.length, 2);
  assert.equal(member.payload.state.pointHistory[0].balanceAfter, 100);
  const memberSelectedAsAdmin = await login('XSOL-0000-001', MEMBER_PASSWORD, 'admin');
  assert.equal(memberSelectedAsAdmin.response.status, 401);

  const forbiddenPointsAdjustment = await callApi('/api/admin/members/XSOL-0000-001/points', {
    method: 'POST',
    cookie: memberCookie,
    body: { delta: 10, reason: 'Unauthorized test' }
  });
  assert.equal(forbiddenPointsAdjustment.response.status, 403);

  const announcement = await callApi('/api/admin/announcements', {
    method: 'POST',
    cookie: adminCookie,
    body: { title: 'Circle update', body: 'The next gathering is confirmed.' }
  });
  assert.equal(announcement.response.status, 201);

  const event = await callApi('/api/admin/events', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      title: 'Circle gathering',
      startsAt: new Date(Date.now() + 2 * 86400000).toISOString(),
      details: 'Monthly member meeting.'
    }
  });
  assert.equal(event.response.status, 201);

  const forbiddenAdminAction = await callApi('/api/admin/announcements', {
    method: 'POST',
    cookie: memberCookie,
    body: { title: 'Nope', body: 'Members cannot publish this.' }
  });
  assert.equal(forbiddenAdminAction.response.status, 403);
  const crossOriginWrite = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
    method: 'POST',
    headers: {
      Cookie: memberCookie,
      Origin: 'http://untrusted.example',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ text: 'Cross-origin request' })
  });
  assert.equal(crossOriginWrite.status, 403);

  const task = await callApi('/api/tasks', {
    method: 'POST',
    cookie: memberCookie,
    body: { text: 'Attend the circle meeting' }
  });
  assert.equal(task.response.status, 201);

  const rsvp = await callApi(`/api/events/${event.payload.id}/rsvp`, {
    method: 'POST',
    cookie: memberCookie,
    body: {}
  });
  assert.equal(rsvp.response.status, 200);
  assert.equal(rsvp.payload.rsvped, true);

  const checkin = await callApi('/api/checkins', {
    method: 'POST',
    cookie: memberCookie,
    body: { note: 'Weekly circle meeting' }
  });
  assert.equal(checkin.response.status, 201);

  const issuedNotice = await callApi('/api/admin/notices', {
    method: 'POST',
    cookie: adminCookie,
    body: { memberCode: 'XSOL-0000-001', type: 'Warning', details: 'Missed the scheduled check-in.' }
  });
  assert.equal(issuedNotice.response.status, 201);

  const memberState = await callApi('/api/state', { cookie: memberCookie });
  assert.equal(memberState.response.status, 200);
  assert.equal(memberState.payload.state.notices.length, 1);
  assert.equal(memberState.payload.state.tasks[0].text, 'Attend the circle meeting');
  assert.equal(memberState.payload.state.checkins[0].note, 'Weekly circle meeting');
  assert.equal(memberState.payload.state.announcements[0].title, 'Circle update');
  assert.equal(memberState.payload.state.events[0].rsvped, true);

  const recovered = await callApi('/api/admin/members/recover', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      oldCode: 'XSOL-0000-001',
      newCode: 'XSOL-0000-002',
      password: 'member-recovered-password-453'
    }
  });
  assert.equal(recovered.response.status, 200);
  assert.equal((await callApi('/api/state', { cookie: memberCookie })).response.status, 401);

  await stopServer();
  startServer();
  await waitForServer();

  const recoveredMember = await login('XSOL-0000-002', 'member-recovered-password-453', 'member');
  assert.equal(recoveredMember.response.status, 200);
  assert.equal(recoveredMember.payload.state.tasks[0].text, 'Attend the circle meeting');
  assert.equal(recoveredMember.payload.state.notices[0].details, 'Missed the scheduled check-in.');
  assert.equal(recoveredMember.payload.state.checkins[0].note, 'Weekly circle meeting');
  assert.equal(recoveredMember.payload.state.events[0].rsvped, true);
  assert.equal(recoveredMember.payload.state.user.points, 100);
  assert.equal(recoveredMember.payload.state.pointHistory.length, 2);

  const recoveredAdmin = await login(FOUNDER_CODE, undefined, 'admin');
  const backup = await fetch(`http://127.0.0.1:${port}/api/admin/backup`, {
    method: 'POST',
    headers: {
      Cookie: recoveredAdmin.cookie,
      Origin: `http://127.0.0.1:${port}`,
      'Content-Type': 'application/json'
    },
    body: '{}'
  });
  assert.equal(backup.status, 200);
  const signature = Buffer.from(await backup.arrayBuffer()).subarray(0, 16).toString('utf8');
  assert.equal(signature, 'SQLite format 3\u0000');
  const snapshots = fs.readdirSync(backupDirectory)
    .filter((filename) => filename.endsWith('.sqlite'))
    .map((filename) => path.join(backupDirectory, filename))
    .sort((first, second) => fs.statSync(second).mtimeMs - fs.statSync(first).mtimeMs);
  assert.ok(snapshots.length > 0);

  await stopServer();
  const restored = spawnSync(process.execPath, [
    '--disable-warning=ExperimentalWarning',
    'server.js',
    'restore',
    snapshots[0]
  ], { cwd: ROOT, env: serverEnvironment(), encoding: 'utf8' });
  assert.equal(restored.status, 0, restored.stderr || restored.stdout);
  startServer();
  await waitForServer();
  const restoredMember = await login('XSOL-0000-002', 'member-recovered-password-453', 'member');
  assert.equal(restoredMember.response.status, 200);
  assert.equal(restoredMember.payload.state.notices[0].details, 'Missed the scheduled check-in.');
  assert.equal(restoredMember.payload.state.announcements[0].title, 'Circle update');
  assert.equal(restoredMember.payload.state.user.points, 100);

  await stopServer();
  const legacyDatabase = new DatabaseSync(path.join(dataDirectory, 'portal.sqlite'));
  legacyDatabase.exec('PRAGMA foreign_keys = ON');
  legacyDatabase.exec('BEGIN IMMEDIATE; PRAGMA defer_foreign_keys = ON');
  legacyDatabase.prepare('UPDATE users SET code = ? WHERE code = ?')
    .run(LEGACY_FOUNDER_CODE, FOUNDER_CODE);
  legacyDatabase.prepare('UPDATE point_transactions SET admin_code = ? WHERE admin_code = ?')
    .run(LEGACY_FOUNDER_CODE, FOUNDER_CODE);
  legacyDatabase.prepare('UPDATE discipline SET created_by = ? WHERE created_by = ?')
    .run(LEGACY_FOUNDER_CODE, FOUNDER_CODE);
  legacyDatabase.exec('COMMIT');
  legacyDatabase.close();
  startServer();
  await waitForServer();

  const oldFounderLogin = await login(LEGACY_FOUNDER_CODE, undefined, 'admin');
  assert.equal(oldFounderLogin.response.status, 401);
  const newFounderLogin = await login(FOUNDER_CODE, undefined, 'admin');
  assert.equal(newFounderLogin.response.status, 200);
  assert.equal(newFounderLogin.payload.state.user.name, 'Xenoford');
});
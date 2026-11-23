#!/usr/bin/env node
/**
 * check:dev-surface — proves the developer surface is gated, and that the gate is
 * testing something real.
 *
 * Why this gate is shaped this way:
 * A purely negative test ("the dev button is not in the HTML") passes just as happily
 * when the renderer is broken, when the wrong function is imported, or when the page
 * failed to build. So every negative assertion here is paired with a POSITIVE control
 * that must pass first. If the positive control fails, the whole gate is invalid and
 * says so, rather than reporting a comfortable green.
 */

const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const server = require(path.join(root, 'out', 'host', 'standaloneServer.js'));
const devAuth = require(path.join(root, 'out', 'devAuth.js'));

const SESSION_TOKEN = 'sekrit-session-token-value';
const checks = [];
let failures = 0;

function check(name, fn) {
  try {
    fn();
    checks.push({ name, ok: true });
  } catch (err) {
    checks.push({ name, ok: false, error: err && err.message ? err.message : String(err) });
    failures += 1;
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    checks.push({ name, ok: true });
  } catch (err) {
    checks.push({ name, ok: false, error: err && err.message ? err.message : String(err) });
    failures += 1;
  }
}

// ── 1. Positive control: the public renderer actually produces a page ─────────────
let publicHtml = '';
check('CONTROL: public renderer returns a non-trivial document', () => {
  assert.strictEqual(typeof server.renderStandaloneDesktopHtml, 'function', 'renderer is not exported');
  publicHtml = server.renderStandaloneDesktopHtml(root, 201, SESSION_TOKEN);
  assert.ok(publicHtml.length > 20000, `public HTML suspiciously small (${publicHtml.length} chars)`);
  assert.ok(publicHtml.includes('id="themeSelect"'), 'public page is missing the theme selector');
  assert.ok(publicHtml.includes('id="chatMessages"'), 'public page is missing the chat thread');
});

// ── 2. Negative: the public page carries no developer signpost ───────────────────
check('public page has no dev button id', () => {
  assert.ok(!publicHtml.includes('toggleDevModeBtn'), 'public page still ships #toggleDevModeBtn');
});
check('public page has no dev button label', () => {
  assert.ok(!publicHtml.includes('Developer Studio Drawer'), 'public page still advertises the Dev drawer');
});
check('public page has no dev mode handler', () => {
  assert.ok(!publicHtml.includes('syncDevModeButtons'), 'public page still ships syncDevModeButtons');
});
check('public page does not carry the ethics notice', () => {
  assert.ok(!publicHtml.includes('dev-ethics-notice'), 'notice is in the public page — that is a signpost');
});

// ── 3. Unauthorised dev render: notice first, and no capability ──────────────────
let unauthHtml = '';
check('CONTROL: unauthorised dev render produces a page', () => {
  assert.strictEqual(typeof server.renderDevSurfaceHtml, 'function', 'renderDevSurfaceHtml is not exported');
  unauthHtml = server.renderDevSurfaceHtml({
    authorized: false,
    tokenPresent: false,
    tokenDisplayPath: devAuth.getDevTokenDisplayPath(),
    toolCount: 201,
    sessionToken: SESSION_TOKEN, // deliberately passed to prove it is withheld
  });
  assert.ok(unauthHtml.length > 1000, 'unauthorised dev page suspiciously small');
  assert.ok(unauthHtml.includes('data-testid="dev-ethics-notice"'), 'ethics notice missing');
  assert.ok(unauthHtml.includes('id="devToken"'), 'unlock control missing');
});

check('unauthorised dev render leaks no inspector', () => {
  assert.ok(!unauthHtml.includes('devToolList'), 'unauthorised render included the tool list');
  assert.ok(!unauthHtml.includes('devToolRun'), 'unauthorised render included the run control');
});
check('unauthorised dev render withholds the session token', () => {
  assert.ok(!unauthHtml.includes(SESSION_TOKEN), 'unauthorised render leaked the session token');
});
check('ethics notice precedes the unlock control in DOM order', () => {
  const notice = unauthHtml.indexOf('dev-ethics-notice');
  const control = unauthHtml.indexOf('id="devToken"');
  assert.ok(notice !== -1 && control !== -1, 'could not locate notice or control');
  assert.ok(notice < control, `notice at ${notice} is not before control at ${control}`);
});

// ── 4. Authorised dev render: catalog present, notice still first ────────────────
check('CONTROL: authorised dev render produces the inspector', () => {
  const authHtml = server.renderDevSurfaceHtml({
    authorized: true,
    tokenPresent: true,
    tokenDisplayPath: devAuth.getDevTokenDisplayPath(),
    toolCount: 201,
    sessionToken: SESSION_TOKEN,
  });
  assert.ok(authHtml.includes('id="devToolList"'), 'authorised render is missing the tool list');
  assert.ok(authHtml.includes(SESSION_TOKEN), 'authorised render should carry the session token');
  const notice = authHtml.indexOf('dev-ethics-notice');
  const catalog = authHtml.indexOf('id="devToolList"');
  assert.ok(notice < catalog, 'ethics notice must come before the inspector');
});

// The Dev columns that used to live behind a toggle are gone. This asserts the
// capability MOVED to /dev rather than vanishing — a real inspector: list, schema,
// JSON input, a run control, and a call to the tool route.
check('inspector restores the capability removed with the Dev toggle', () => {
  const authHtml = server.renderDevSurfaceHtml({
    authorized: true,
    tokenPresent: true,
    tokenDisplayPath: devAuth.getDevTokenDisplayPath(),
    toolCount: 201,
    sessionToken: SESSION_TOKEN,
  });
  for (const part of ['devToolList', 'devToolSearch', 'devToolSchema', 'devToolInput', 'devToolRun', 'devToolOutput']) {
    assert.ok(authHtml.includes(part), `inspector is missing ${part}`);
  }
  assert.ok(authHtml.includes('/api/tools'), 'inspector never reads the tool catalog route');
  assert.ok(authHtml.includes('/api/tool'), 'inspector never calls the tool execution route');
});

// ── 5. Token path privacy ────────────────────────────────────────────────────────
check('display path is unexpanded and reveals no home directory', () => {
  const display = devAuth.getDevTokenDisplayPath();
  const os = require('os');
  assert.ok(display.includes('%LOCALAPPDATA%') || display.includes('$XDG_CONFIG_HOME'),
    `display path is not the unexpanded form: ${display}`);
  assert.ok(!display.includes(os.homedir()), 'display path contains the real home directory');
});

// ── 6. Fail closed ───────────────────────────────────────────────────────────────
check('empty token never authorises', () => {
  assert.strictEqual(devAuth.verifyDevToken(''), false, 'empty token was accepted');
  assert.strictEqual(devAuth.verifyDevToken('   '), false, 'whitespace token was accepted');
});
check('missing session never authorises', () => {
  devAuth.resetDevSessionsForTests();
  assert.strictEqual(devAuth.verifyDevSession(''), false, 'empty session was accepted');
  assert.strictEqual(devAuth.verifyDevSession('made-up'), false, 'unknown session was accepted');
  assert.strictEqual(devAuth.verifyDevSession(null), false, 'null session was accepted');
});
check('a minted session authorises, and dies when reset', () => {
  const session = devAuth.mintDevSession();
  assert.strictEqual(devAuth.verifyDevSession(session.id), true, 'minted session was not accepted');
  devAuth.resetDevSessionsForTests();
  assert.strictEqual(devAuth.verifyDevSession(session.id), false, 'session survived a reset');
});

// ── 7. Constant-time comparison behaves ──────────────────────────────────────────
check('comparison rejects length mismatch and accepts equality', () => {
  assert.strictEqual(devAuth.safeTokenEquals('abc', 'abc'), true, 'equal tokens rejected');
  assert.strictEqual(devAuth.safeTokenEquals('abc', 'abcd'), false, 'length mismatch accepted');
  assert.strictEqual(devAuth.safeTokenEquals('', ''), false, 'two empty tokens accepted');
});

// ── 8. Live loopback HTTP proof: /api/tools & /api/tool require devAuth cookie ───
(async () => {
  let handle;
  try {
    handle = await server.startStandaloneDesktopServer({
      workspaceRoot: root,
      port: 0,
      openAppWindow: false,
      requireTokenForExternal: true,
    });
    const base = `http://127.0.0.1:${handle.port}`;
    const tok = handle.token;

    devAuth.resetDevSessionsForTests();

    await checkAsync('HTTP NEGATIVE: GET /api/tools with valid x-harmony-token returns 403 and zero tools without dev cookie', async () => {
      const r = await fetch(`${base}/api/tools`, { headers: { 'x-harmony-token': tok } });
      const body = await r.json();
      assert.strictEqual(r.status, 403, `expected 403, got ${r.status}`);
      assert.ok(!Array.isArray(body.tools), 'unauthorised /api/tools leaked tools array');
    });

    await checkAsync('HTTP NEGATIVE: POST /api/tool with valid x-harmony-token returns 403 without dev cookie', async () => {
      const r = await fetch(`${base}/api/tool`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-harmony-token': tok,
          Cookie: `${devAuth.DEV_COOKIE_NAME}=forged-session`,
        },
        body: JSON.stringify({ name: 'harmony_git_status', input: {} }),
      });
      assert.strictEqual(r.status, 403, `expected 403, got ${r.status}`);
    });

    await checkAsync('HTTP POSITIVE: minted dev session + x-harmony-token unlocks GET /api/tools (>150 tools)', async () => {
      const minted = devAuth.mintDevSession();
      const cookieHdr = `${devAuth.DEV_COOKIE_NAME}=${encodeURIComponent(minted.id)}`;
      const r = await fetch(`${base}/api/tools`, {
        headers: { 'x-harmony-token': tok, Cookie: cookieHdr },
      });
      const body = await r.json();
      assert.strictEqual(r.status, 200, `expected 200 with dev cookie, got ${r.status}`);
      assert.ok(Array.isArray(body.tools) && body.tools.length > 150, `expected >150 tools, got ${body.tools && body.tools.length}`);

      // Foreign Origin on POST /api/tool must still be rejected even WITH valid dev cookie (CSRF guard)
      const csrf = await fetch(`${base}/api/tool`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-harmony-token': tok,
          Cookie: cookieHdr,
          Origin: 'https://evil.example',
        },
        body: JSON.stringify({ name: 'harmony_git_status', input: {} }),
      });
      assert.strictEqual(csrf.status, 403, `expected 403 on cross-origin POST /api/tool, got ${csrf.status}`);
    });

    await checkAsync('COLLAB ROUTE: /api/collab spawn validates task & provider allowlist without /api/tool', async () => {
      const missingTask = await server.handleCollabStudioRoute(root, { action: 'spawn', task: '   ' });
      assert.strictEqual(missingTask.ok, false, 'empty spawn task should fail closed');
      const badProvider = await server.handleCollabStudioRoute(root, { action: 'spawn', task: 'check', provider: 'not-a-provider' });
      assert.strictEqual(badProvider.ok, false, 'unlisted spawn provider should fail closed');
      assert.ok(publicHtml.includes("'/api/collab'"), 'public page Collaborator button does not route through /api/collab');
    });
  } finally {
    devAuth.resetDevSessionsForTests();
    if (handle && typeof handle.close === 'function') {
      await handle.close();
    }
  }

  const pad = checks.map(c => `${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : `\n        ${c.error}`}`);
  console.log(pad.join('\n'));

  if (failures > 0) {
    console.error(`\ncheck-dev-surface: ${checks.length - failures}/${checks.length} passed, ${failures} FAILED`);
    process.exit(1);
  }
  console.log(`\ncheck-dev-surface: ${checks.length}/${checks.length} passed, 0 failed`);
})();

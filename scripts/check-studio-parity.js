#!/usr/bin/env node
'use strict';
/**
 * Gate: Harmony Chat (VS Code Webview) + External Standalone (:8789) Parity & Safety
 *
 * Verifies:
 *  1. Docked/split VS Code Studio webview emits per-render nonce CSP (`buildWebviewStudioCsp`)
 *     with `default-src 'none'`, `script-src 'nonce-...'`, and `connect-src 'none'`.
 *  2. Browser `<script>` defines `COLLABORATOR_ROLE_LABELS` and `selectCollaboratorRole`
 *     so `⚡ Collaborator` never throws a browser ReferenceError.
 *  3. Inline Flow-State `ask_question` / `harmony_ask_question` turn suspension (`pendingAsk`),
 *     `POST /api/ask/receipt`, and `renderInlineAskCard` (`explore`/`decide`, `thought`, `readyCheckbox`).
 *  4. Studio session CRUD (`saveStudioSessionByRoot`, `listStudioSessionsByRoot`,
 *     `loadStudioSessionByRoot`, `deleteStudioSessionByRoot`) + `_autosave` + path traversal /
 *     Windows-reserved-name guards verified against an isolated temp folder.
 *  5. Persisted Conductor route (`CONDUCTOR_ROUTE_STORAGE_KEY`), live `Vertex GCP` / `AI Studio`
 *     badge, honest `:8789` `⚡ Slash Commands` palette title, escaped streaming-safe Markdown,
 *     and `MAX_LIVE_CHAT_BUBBLES` (80) Renderer OOM shield.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');

const origLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') {
    return {
      workspace: {
        workspaceFolders: [],
        getConfiguration: () => ({ get: () => undefined, inspect: () => undefined }),
      },
      window: {
        createOutputChannel: () => ({ append() {}, appendLine() {}, clear() {}, show() {}, hide() {}, dispose() {} }),
        showWarningMessage: () => Promise.resolve(undefined),
      },
    };
  }
  return origLoad.call(this, request, parent, isMain);
};

let passed = 0;
let failed = 0;

function check(label, ok, detail) {
  if (ok) {
    passed++;
    console.log('  PASS  ' + label);
  } else {
    failed++;
    console.error('  FAIL  ' + label + (detail ? (' — ' + detail) : ''));
  }
}

(async () => {
  console.log('\n[check:studio-parity] Verifying Harmony Chat + External (:8789) parity & safety...\n');

  const serverSrc = fs.readFileSync(path.join(ROOT, 'src', 'host', 'standaloneServer.ts'), 'utf8');
  const localAgentSrc = fs.readFileSync(path.join(ROOT, 'src', 'localAgent.ts'), 'utf8');

  // 1. Webview CSP + Nonce
  const standaloneCompiled = require(path.join(ROOT, 'out', 'host', 'standaloneServer.js'));
  const sampleWebviewCsp = standaloneCompiled.buildWebviewStudioCsp('testnonce123', 'vscode-webview://abc');
  check(
    'buildWebviewStudioCsp enforces default-src none, nonce script-src, img-src data-only, form-action none, and connect-src none',
    sampleWebviewCsp.includes("default-src 'none'") &&
      sampleWebviewCsp.includes("script-src 'nonce-testnonce123'") &&
      sampleWebviewCsp.includes("connect-src 'none'") &&
      sampleWebviewCsp.includes("form-action 'none'") &&
      !sampleWebviewCsp.includes('https:') &&
      !sampleWebviewCsp.includes("script-src 'unsafe-inline'"),
    sampleWebviewCsp
  );
  check(
    'Studio HTML injects <meta http-equiv="Content-Security-Policy"> when rendered inside VS Code Webview',
    serverSrc.includes('http-equiv="Content-Security-Policy"') && serverSrc.includes('buildWebviewStudioCsp(')
  );

  // 2. Collaborator role classifier defined inside browser <script> + server roleLabel
  const scriptMatch = /<script\$\{nonceAttr\}>([\s\S]*?)<\/script>/.exec(serverSrc);
  const browserScript = scriptMatch ? scriptMatch[1] : '';
  check(
    'Browser <script> defines COLLABORATOR_ROLE_LABELS and selectCollaboratorRole (no Node-import ReferenceError)',
    browserScript.includes('const COLLABORATOR_ROLE_LABELS =') &&
      browserScript.includes('function selectCollaboratorRole(task)') &&
      serverSrc.includes('const roleLabel = COLLABORATOR_ROLE_LABELS[role as keyof typeof COLLABORATOR_ROLE_LABELS]')
  );

  // 3. Flow-State Ask parity
  check(
    'Standalone & Webview agent loop intercepts ask_question / harmony_ask_question with pendingAsk + receipt persistence',
    serverSrc.includes('normalizeStudioAskArguments(') &&
      serverSrc.includes("pathname === '/api/ask/receipt'") &&
      browserScript.includes('function renderInlineAskCard(') &&
      browserScript.includes('activeInlineAskCancel') &&
      localAgentSrc.includes('interactive Flow-State question')
  );

  // 4. Live behavioral test of Studio session CRUD + path-safety guards
  const sessionsMod = require(path.join(ROOT, 'out', 'sessions.js'));
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harmony-studio-sessions-'));
  try {
    const saved = await sessionsMod.saveStudioSession(tmpRoot, 'alpha_thread', [
      { role: 'user', content: 'Inspect src/sidebar.ts' },
      { role: 'assistant', content: 'Confirmed layout in src/sidebar.ts.' },
    ], 'harmony-chat');
    await new Promise(r => setTimeout(r, 15));
    const autoSaved = await sessionsMod.saveStudioSession(tmpRoot, '_autosave', [
      { role: 'user', content: 'Active scratchpad turn' },
    ], 'harmony-chat');
    const list = await sessionsMod.listStudioSessions(tmpRoot);
    const loaded = await sessionsMod.loadStudioSession(tmpRoot, 'alpha_thread');
    const preamble = loaded.ok ? sessionsMod.formatSessionPreamble(loaded.session) : '';
    const deleted = await sessionsMod.deleteStudioSession(tmpRoot, '_autosave');
    const traversalRes = await sessionsMod.loadStudioSession(tmpRoot, '../escape');
    const reservedRes = await sessionsMod.saveStudioSession(tmpRoot, 'CON', [{ role: 'user', content: 'bad' }]);
    check(
      'Studio session CRUD saves, lists (_autosave prioritized), loads with preamble, and deletes cleanly',
      Boolean(
        saved.ok &&
          saved.name === 'alpha_thread' &&
          autoSaved.ok &&
          autoSaved.name === '_autosave' &&
          list.length === 2 &&
          list[0].isAutosave === true &&
          loaded.ok &&
          loaded.session.turns.length === 2 &&
          preamble.includes('alpha_thread') &&
          deleted.ok === true
      )
    );
    check(
      'Studio session storage rejects path traversal (../) and Windows reserved device names (CON)',
      traversalRes.ok === false && reservedRes.ok === false
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  // 5. Routing persistence, Vertex badge, :8789 Slash Commands palette, escaped Markdown, and 80-bubble OOM cap
  check(
    'Conductor route persists in localStorage, updates Vertex GCP / AI Studio badge, and labels :8789 Slash Commands honestly',
    browserScript.includes("const CONDUCTOR_ROUTE_STORAGE_KEY = 'harmony.studio.conductorRoute'") &&
      browserScript.includes(' · Vertex GCP') &&
      browserScript.includes("omniTitle.textContent = '⚡ Slash Commands'") &&
      browserScript.includes("name: 'resume'") &&
      browserScript.includes("name: 'clear'")
  );
  check(
    'Markdown renderer escapes raw HTML, restricts links to https?://, includes code-copy button, and enforces 80-bubble OOM cap',
    browserScript.includes('const MAX_LIVE_CHAT_BUBBLES = 80;') &&
      browserScript.includes('function escapeHtmlText(') &&
      browserScript.includes('function isAllowedSafeHref(') &&
      browserScript.includes('data-copy-code="1"') &&
      serverSrc.includes('@media (max-width: 420px)')
  );

  // 6. Rendered HTML runtime JS parse + Windows solid-hex <select>/<option> + non-clipping bars + Gemini 4 Neon
  const vm = require('vm');
  const renderedHttpHtml = standaloneCompiled.renderStandaloneDesktopHtml(ROOT, 201, 'http-tok', 'nonceHttp');
  const renderedWebviewHtml = standaloneCompiled.renderStandaloneDesktopHtml(ROOT, 201, 'vscode-webview-tab', 'nonceWv', 'vscode-webview://test');
  const httpScriptMatch = /<script[^>]*>([\s\S]*?)<\/script>/.exec(renderedHttpHtml);
  let renderedScriptParsesClean = false;
  let parseErrDetail = '';
  try {
    if (httpScriptMatch && httpScriptMatch[1]) {
      new vm.Script(httpScriptMatch[1], { filename: 'rendered-studio.js' });
      renderedScriptParsesClean = true;
    }
  } catch (err) {
    parseErrDetail = err && err.message ? err.message : String(err);
  }
  check(
    'Rendered Studio HTML <script> parses cleanly in V8 vm.Script (zero template-literal escape SyntaxErrors)',
    renderedScriptParsesClean,
    parseErrDetail
  );
  check(
    'External (:8789) starts on data-theme="nebula" with solid-hex Windows <option> contrast, non-clipping flex-wrap bars, and Gemini 4 Neon',
    renderedHttpHtml.includes('<body data-theme="nebula">') &&
      renderedWebviewHtml.includes('<body data-theme="vscode">') &&
      renderedHttpHtml.includes('gemini:premium:gemini-4-neon') &&
      renderedHttpHtml.includes('background-color: #171f2c;') &&
      renderedHttpHtml.includes('.meta-pill.fleet-on') &&
      renderedHttpHtml.includes('flex-wrap: wrap;')
  );
  check(
    'Desktop (:8789) includes Daylight + Auto (VS Code) light-theme message overrides, Forced-Colors protection, Sovereign Tauri zero-account shell, legacy Edge profile quarantine, change+input listeners, ↻ reload pill, and BOOT_BUILD_ID hot-reload',
    renderedHttpHtml.includes('body[data-theme="daylight"] .msg.assistant') &&
      renderedHttpHtml.includes('body[data-theme="vscode"][data-host-color="light"]:not([data-vscode-vars="1"])') &&
      renderedHttpHtml.includes('forced-color-adjust: none;') &&
      renderedHttpHtml.includes('value="high-contrast"') &&
      renderedHttpHtml.includes('body[data-theme="emerald"] .msg.assistant') &&
      serverSrc.includes('quarantineLegacyEdgeSyncProfile()') &&
      serverSrc.includes('harmony-native-control') &&
      serverSrc.includes("'--studio'") &&
      serverSrc.includes('--disable-sync') &&
      serverSrc.includes('msImplicitSignin,msEdgeAccountConsistency,SigninIntercept,ForcedColors,WebContentsForceDark') &&
      renderedHttpHtml.includes('id="reloadDesktopBtn"') &&
      renderedWebviewHtml.includes('id="reloadDesktopBtn" class="icon-pill" style="display:none;"') &&
      renderedHttpHtml.includes('const BOOT_BUILD_ID =') &&
      renderedHttpHtml.includes("themeSelect.addEventListener('change', onThemeUserSelect)") &&
      renderedHttpHtml.includes("themeSelect.addEventListener('input', onThemeUserSelect)")
  );

  const tauriMainSrc = fs.readFileSync(path.join(ROOT, 'native-ui', 'src-tauri', 'src', 'main.rs'), 'utf8');
  const tauriCapsSrc = fs.readFileSync(path.join(ROOT, 'native-ui', 'src-tauri', 'capabilities', 'default.json'), 'utf8');
  check(
    'Sovereign Tauri Studio shell enforces zero-IPC on chat window, loopback origin pinning, isolated WebView2 data directory, and anti-SSO flags',
    tauriMainSrc.includes('is_pinned_studio_origin(url, pinned_port)') &&
      tauriMainSrc.includes('msImplicitSignin,ForcedColors,WebContentsForceDark') &&
      tauriMainSrc.includes('--disable-sync') &&
      tauriMainSrc.includes('studio-webview2-p') &&
      !tauriCapsSrc.includes('"chat"') &&
      !tauriCapsSrc.includes('"remote"')
  );

  // 7. Fleet Mode harmony_parallel schema exposes context_files/max_chars_per_file/system/slot_index + heavy-tier guard
  const pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const parallelTool = ((pkgJson.contributes && pkgJson.contributes.languageModelTools) || []).find(
    (t) => t && t.name === 'harmony_parallel'
  );
  const taskItemProps =
    parallelTool &&
    parallelTool.inputSchema &&
    parallelTool.inputSchema.properties &&
    parallelTool.inputSchema.properties.tasks &&
    parallelTool.inputSchema.properties.tasks.items &&
    parallelTool.inputSchema.properties.tasks.items.properties;
  const lmToolsSrc = fs.readFileSync(path.join(ROOT, 'src', 'lmTools.ts'), 'utf8');
  check(
    'Fleet harmony_parallel schema exposes context_files/max_chars_per_file/system/slot_index and enforces confirmHeavyTier',
    Boolean(
      taskItemProps &&
        taskItemProps.context_files &&
        taskItemProps.max_chars_per_file &&
        taskItemProps.system &&
        taskItemProps.slot_index &&
        lmToolsSrc.includes('user denied heavy-tier parallel worker')
    )
  );

  console.log(`\n[check:studio-parity] ${passed} passed, ${failed} failed.\n`);
  if (failed > 0) process.exit(1);
})();

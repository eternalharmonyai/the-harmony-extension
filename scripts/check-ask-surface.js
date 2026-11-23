#!/usr/bin/env node
/**
 * check:ask-surface — protects the Harmony Ask prompt.
 *
 * What this gate is FOR
 * ---------------------
 * The Ask surface carries two properties that must hold at the same time, and
 * they pull in opposite directions:
 *
 *   1. The question waits INDEFINITELY for an answer. No deadline. A day is fine.
 *   2. The panel must never be mistaken for dead while it is merely slow.
 *
 * Property 1 is provided by chatParticipant's 10-second keep-alive heartbeat. That
 * heartbeat is the SAME mechanism that pushes repeated progress lines into the
 * chat — the "Waiting for your answer..." lines. It is deliberate: it stops the
 * host from timing the turn out. So this gate asserts it is STILL PRESENT and
 * UNCHANGED. Deleting it would look like a tidy-up and would silently destroy the
 * ability to leave a question open for hours.
 *
 * Property 2 was broken: the webview posted 'ready' as the LAST line of its
 * script, so a slow or throwing render meant the host never saw ready, the 30s
 * startup timer fired, and a panel that was about to work got disposed. The gate
 * asserts 'ready' is now posted before the render runs.
 *
 * Shape of the gate
 * -----------------
 * Every negative assertion is paired with a POSITIVE control. A gate that reads an
 * empty string, a missing file, or the wrong module passes all negatives happily
 * and reports a comfortable green. If a control fails, this gate is invalid and
 * says so instead of trusting its own verdict.
 */

const path = require('path');
const fs = require('fs');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const asksrc = path.join(root, 'src', 'askView.ts');
const participantSrc = path.join(root, 'src', 'chatParticipant.ts');

const ask = fs.readFileSync(asksrc, 'utf8');
const participant = fs.readFileSync(participantSrc, 'utf8');

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

function count(haystack, needle) {
  let n = 0;
  let at = 0;
  for (;;) {
    const i = haystack.indexOf(needle, at);
    if (i === -1) return n;
    n += 1;
    at = i + needle.length;
  }
}

// ── Positive controls: we are reading the real files ────────────────────────────
check('CONTROL: both sources were read and are non-trivial', () => {
  assert.ok(ask.length > 10000, `askView.ts suspiciously small (${ask.length} chars)`);
  assert.ok(participant.length > 100000, `chatParticipant.ts suspiciously small (${participant.length} chars)`);
  assert.ok(ask.includes("ASK_VIEW_TYPE = 'harmony.ask'"), 'askView.ts is not the Ask view module');
  assert.ok(participant.includes('invokeHarmonyToolWithTurnKeepAlive'), 'chatParticipant.ts lost the keep-alive helper');
});

// ── 1. The indefinite wait must survive. This is the load-bearing property. ─────
check('CONTROL: ask_question still gets a keep-alive progress heartbeat', () => {
  assert.ok(
    participant.includes("toolName === 'harmony_ask_question'"),
    'the ask_question keep-alive branch was removed — the question would no longer survive a long absence'
  );
  assert.ok(
    participant.includes("'Waiting for your answer...'"),
    'the ask_question progress text changed or vanished'
  );
  assert.ok(participant.includes('stream.progress(progress)'), 'the heartbeat no longer emits progress');
});

check('ensure the keep-alive interval is still 10000ms', () => {
  assert.ok(
    participant.includes('}, 10000);'),
    'the keep-alive interval was changed — an unmeasured cadence risks the host timing the turn out'
  );
});

check('the heartbeat is only cleared in finally, so it cannot leak', () => {
  assert.ok(
    participant.includes('if (keepAlive) clearInterval(keepAlive);'),
    'the keep-alive interval is no longer cleared in finally'
  );
});

// ── 2. No deadline on the ANSWER path ───────────────────────────────────────────
check('the only Ask timeout is still the 30s WEBVIEW-STARTUP deadline', () => {
  assert.ok(
    ask.includes('ASK_READY_TIMEOUT_MS = 30000'),
    'the webview-startup deadline changed; this gate assumed 30000 and must be updated deliberately'
  );
  assert.strictEqual(
    count(ask, 'ASK_READY_TIMEOUT_MS'),
    2,
    'ASK_READY_TIMEOUT_MS is used somewhere new — it must only configure the startup timer'
  );
  assert.strictEqual(
    count(ask, 'session.readyTimer = setTimeout('),
    1,
    'the startup timer was duplicated or moved; only one startup deadline is allowed'
  );
  assert.ok(
    !ask.includes('session.readyTimer = setTimeout(() => {\n            resolve'),
    'a timeout now resolves the batch, which would put a deadline on the answer'
  );
});

check('the startup timer is cleared the moment the panel reports ready', () => {
  assert.ok(
    ask.includes('if (session.readyTimer) clearTimeout(session.readyTimer);'),
    'the startup timer is no longer cleared on ready, so a ready panel could still be failed'
  );
});

// ── 3. 'ready' must precede the render (the actual regression) ──────────────────
check("'ready' is posted AFTER the host listener and BEFORE the initial render", () => {
  const readyAt = ask.indexOf("vscode.postMessage({ type: 'ready' });");
  const listenerAt = ask.indexOf("window.addEventListener('message'");
  // The render tail is the LAST bootstrap in the script; the earlier one belongs
  // to the queueInit handler. Anchor with lastIndexOf, never indexOf.
  const bootstrap = 'items.forEach((it, idx) => ensureDraft(it, idx === 0));';
  const renderAt = ask.lastIndexOf(bootstrap);
  assert.ok(readyAt !== -1, "'ready' is no longer posted by the panel script");
  assert.ok(listenerAt !== -1, 'the panel no longer registers a message listener');
  assert.ok(renderAt !== -1, 'the initial render tail vanished, so this gate cannot locate it');
  assert.ok(
    ask.indexOf(bootstrap) !== renderAt,
    'expected TWO bootstrap calls (queueInit handler + render tail); the script shape changed'
  );
  // DeepSeek Coding review, 2026-11-09: posting 'ready' before the listener was
  // safe only by event-loop reasoning, and became UNSAFE if the script throws
  // before addEventListener — queueInit would then be dispatched to a document
  // with no listener and be lost. Ordering must be guaranteed, not argued.
  assert.ok(
    readyAt > listenerAt,
    "'ready' is posted before the host listener is registered — a throw in between would lose queueInit"
  );
  assert.ok(
    readyAt < renderAt,
    "'ready' is posted AFTER the render again — a slow render would be mistaken for a dead panel"
  );
});

check("'ready' is posted exactly once", () => {
  assert.strictEqual(
    count(ask, "vscode.postMessage({ type: 'ready' });"),
    1,
    "'ready' is posted more than once, which would re-send queueInit and reset drafts"
  );
});

// ── 4. Failures must be audible (AGENTS.md rule #6) ─────────────────────────────
check('the Ask failure is logged and surfaced, not swallowed', () => {
  assert.ok(ask.includes('function logAskFailure('), 'the Ask failure logger was removed');
  assert.ok(ask.includes('logAskFailure('), 'nothing calls the Ask failure logger');
  assert.ok(
    ask.includes('Ask panel did not become ready'),
    'the ready-timeout failure is no longer described when logged'
  );
});

check('the fallback catch is bound, so the error is not discarded unread', () => {
  assert.ok(!ask.includes('} catch {\n        if (token?.isCancellationRequested)'), 'the fallback catch is bare again');
  assert.ok(ask.includes('catch (err) {'), 'the fallback catch no longer binds the error');
});

check('a panel script crash is reported to the host', () => {
  assert.ok(
    ask.includes("type: 'renderFailed'"),
    'the panel script no longer reports render failures'
  );
  assert.ok(
    ask.includes("if (msg.type === 'renderFailed')"),
    'the host no longer handles renderFailed'
  );
});

// ── 5. Invariants born from the project owner's own words ───────────────────────
check('no timing-pressure message was introduced', () => {
  // Only phrases that imply the USER is being too slow. Deliberately narrow:
  // "Please answer Question 3 of 5" is helpful validation when submitting with a
  // gap, and must not be swept up by a blunt keyword match.
  const banned = ['taking longer than expected', 'timed out waiting', 'still waiting for you', 'hurry up'];
  for (const phrase of banned) {
    assert.ok(
      !ask.toLowerCase().includes(phrase),
      `askView.ts tells the user to hurry up ("${phrase}") — waiting is the correct behaviour`
    );
  }
});

check('dead session state stays removed', () => {
  assert.strictEqual(
    count(ask, 'closingForSubmit'),
    0,
    'closingForSubmit was written but never read; it should not come back'
  );
});

// ── 6. The rich panel is untouched — the happy path must not regress ────────────
check('CONTROL: the rich panel UI is still complete', () => {
  for (const marker of [
    'acquireVsCodeApi()',
    'id="queuePills"',
    'id="answer"',
    'id="readyRow"',
    'id="answerBtn"',
    'id="cancel"',
    'multiSelect',
    'queueAppend',
    'queueInit',
    "nonce-${nonce}",
  ]) {
    assert.ok(ask.includes(marker), `the Ask panel lost "${marker}"`);
  }
});

check('the fallback prompt is not focus-trappable by accident of wording', () => {
  assert.ok(
    ask.includes('ignoreFocusOut: true'),
    'ignoreFocusOut was removed from the native fallback — a stray click would now discard the question'
  );
});

// ── 7. Flow-State schema parity + compiled thought rendering & receipt persistence ──
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
function assertAskToolSchema(pkgObj, toolName) {
  const tool = ((pkgObj.contributes && pkgObj.contributes.languageModelTools) || []).find(t => t.name === toolName);
  assert.ok(tool && tool.inputSchema && tool.inputSchema.properties, `${toolName}: missing inputSchema.properties`);
  const props = tool.inputSchema.properties;
  const nested = (props.questions && props.questions.items && props.questions.items.properties) || {};
  for (const field of ['mode', 'thought', 'readyCheckbox', 'readyLabel']) {
    assert.ok(props[field], `${toolName}: missing top-level ${field}`);
    assert.ok(nested[field], `${toolName}: missing questions.items.properties.${field}`);
  }
}

check('CONTROL + SCHEMA: all 3 Ask tool entries expose mode, thought, readyCheckbox, readyLabel', () => {
  for (const name of ['harmony_ask_question', 'harmony_ask_harmony', 'harmony_ask_questions']) {
    assertAskToolSchema(pkg, name);
  }
  const broken = JSON.parse(JSON.stringify(pkg));
  const target = broken.contributes.languageModelTools.find(t => t.name === 'harmony_ask_questions');
  delete target.inputSchema.properties.questions.items.properties.thought;
  assert.throws(() => assertAskToolSchema(broken, 'harmony_ask_questions'), /thought/);
});

check('COMPILED: formatAskQuestionText surfaces mode + thought and persistHarmonyAskReceipt saves & fails audibly', () => {
  const os = require('os');
  const Module = require('module');
  const compiledPath = path.join(root, 'out', 'askView.js');
  assert.ok(fs.existsSync(compiledPath), `missing compiled ${compiledPath} — run npm run compile first`);

  const loggedFailures = [];
  const vscodeStub = {
    window: {
      createOutputChannel: () => ({ appendLine: line => loggedFailures.push(String(line)) }),
      setStatusBarMessage: () => ({ dispose() {} }),
    },
    workspace: { workspaceFolders: [] },
  };
  const oldLoad = Module._load;
  Module._load = function (req, parent, isMain) {
    if (req === 'vscode') return vscodeStub;
    return oldLoad.call(this, req, parent, isMain);
  };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harmony-ask-gate-'));
  try {
    delete require.cache[compiledPath];
    const askMod = require(compiledPath);
    assert.strictEqual(typeof askMod.formatAskQuestionText, 'function', 'formatAskQuestionText not exported');
    assert.strictEqual(typeof askMod.persistHarmonyAskReceipt, 'function', 'persistHarmonyAskReceipt not exported');

    const formatted = askMod.formatAskQuestionText({
      header: 'Check-In',
      mode: 'explore',
      thought: 'unique-thought-marker-771',
      question: 'Which path?',
      message: 'Extra context',
    });
    assert.ok(formatted.includes('Explore'), 'mode tag missing from formatted text');
    assert.ok(formatted.includes('unique-thought-marker-771'), 'thought was silently dropped');
    assert.ok(formatted.includes('Which path?'), 'question missing from formatted text');

    const saved = askMod.persistHarmonyAskReceipt(
      [{ question: 'What next?', multiline: true }],
      ['Build the resilience gate!'],
      tmp
    );
    assert.strictEqual(saved.ok, true, `expected receipt write ok, got ${saved.error}`);
    assert.ok(fs.existsSync(saved.jsonlPath), 'answers.jsonl not created');
    assert.ok(fs.existsSync(saved.latestPath), 'latest.json not created');
    const latest = JSON.parse(fs.readFileSync(saved.latestPath, 'utf8'));
    assert.strictEqual(latest.items[0].answer, 'Build the resilience gate!');

    // Negative control: file blocking directory creation must return ok:false without throwing AND log audibly (Rule #6)
    const blocker = path.join(tmp, 'not-a-dir');
    fs.writeFileSync(blocker, 'block', 'utf8');
    const beforeLogs = loggedFailures.length;
    const failed = askMod.persistHarmonyAskReceipt([{ question: 'Q' }], ['A'], blocker);
    assert.strictEqual(failed.ok, false, 'unwritable target should return ok:false');
    assert.ok(loggedFailures.length > beforeLogs, 'persist failure was not logged to Harmony Ask output channel');
  } finally {
    Module._load = oldLoad;
    delete require.cache[compiledPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

const pad = checks.map(c => `${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : `\n        ${c.error}`}`);
console.log(pad.join('\n'));

if (failures > 0) {
  console.error(`\ncheck-ask-surface: ${checks.length - failures}/${checks.length} passed, ${failures} FAILED`);
  process.exit(1);
}
console.log(`\ncheck-ask-surface: ${checks.length}/${checks.length} passed, 0 failed`);

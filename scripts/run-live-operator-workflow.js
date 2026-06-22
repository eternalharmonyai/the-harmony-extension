const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'harmony-cli.js');
const id = `live-operator-workflow-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
const tempWorkspace = path.join(os.tmpdir(), id);
const port = 8797 + (process.pid % 800);
const baseUrl = `http://127.0.0.1:${port}`;

function runCli(args) {
  const result = cp.spawnSync(process.execPath, [cli, '--workspace', tempWorkspace, ...args], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`CLI failed: ${args.join(' ')}\n${result.stderr || result.stdout}`);
  }
  return result;
}

function requestJson(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(new URL(pathname, baseUrl), {
      method,
      headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : undefined,
      timeout: 5000,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        let parsed = {};
        try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { text }; }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode} ${pathname}: ${text}`));
          return;
        }
        resolve(parsed);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`Timed out: ${method} ${pathname}`)));
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForBackend() {
  const deadline = Date.now() + 15000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await requestJson('GET', '/state');
      return;
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  throw lastError || new Error('backend did not become ready');
}

async function action(pathname, body) {
  return await requestJson('POST', pathname, body);
}

async function main() {
  fs.mkdirSync(tempWorkspace, { recursive: true });
  fs.writeFileSync(path.join(tempWorkspace, 'loop-live-source.txt'), 'alpha live loop\nbeta live loop\n', 'utf8');
  runCli(['policy', 'init']);
  runCli(['policy', 'set', '--permission', 'autonomousLoops', '--value', 'true', '--confirm']);
  runCli(['policy', 'set', '--maxAutonomousSteps', '3', '--confirm']);

  const server = cp.spawn(process.execPath, [cli, '--workspace', tempWorkspace, 'ui', 'serve', '--port', String(port)], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let serverOutput = '';
  server.stdout.on('data', chunk => { serverOutput += String(chunk); });
  server.stderr.on('data', chunk => { serverOutput += String(chunk); });

  const summary = {
    conversationCreated: false,
    policyGateRecorded: false,
    loopPreflightReady: false,
    plannedSteps: 0,
    oneStepExecuted: false,
    boundedReadOnlyStepsExecuted: false,
    executedSteps: [],
    freshPreviewReceipts: false,
    freshExecuteReceipts: false,
    stopReason: '',
    noProviderCall: false,
    reportPath: '',
    backendListedLoopExecute: false,
  };

  try {
    await waitForBackend();
    summary.backendListedLoopExecute = serverOutput.includes('floating-chat-tool-loop-execute');
    const conversationId = 'live-operator-loop';
    const loopJson = JSON.stringify({ tool_calls: [
      { tool: 'read-file', path: 'loop-live-source.txt', maxChars: 4000 },
      { tool: 'grep', path: 'loop-live-source.txt', pattern: 'loop', maxMatches: 5 },
    ] });

    const turnPreview = await action('/actions/floating-chat-turn', { mode: 'preview', conversationId, message: 'Automated live operator workflow pass.' });
    const turn = await action('/actions/floating-chat-turn', { mode: 'execute', conversationId, message: 'Automated live operator workflow pass.', confirmation: turnPreview.preview.requiredConfirmation, previewReceiptId: turnPreview.preview.previewReceipt.id });
    summary.conversationCreated = turn.ok === true;

    const gatePreview = await action('/actions/outside-tool-policy-gate', { mode: 'preview', reason: 'automated live operator workflow pass' });
    const gate = await action('/actions/outside-tool-policy-gate', { mode: 'execute', reason: 'automated live operator workflow pass', confirmation: gatePreview.preview.requiredConfirmation, previewReceiptId: gatePreview.preview.previewReceipt.id });
    summary.policyGateRecorded = gate.ok === true;

    const preflightPreview = await action('/actions/floating-chat-tool-loop-preflight', { mode: 'preview', conversationId, toolLoopRequest: loopJson, maxSteps: 3 });
    const preflight = await action('/actions/floating-chat-tool-loop-preflight', { mode: 'execute', conversationId, toolLoopRequest: loopJson, maxSteps: 3, confirmation: preflightPreview.preview.requiredConfirmation, previewReceiptId: preflightPreview.preview.previewReceipt.id });
    summary.loopPreflightReady = preflight.ok === true && preflight.report.status === 'ready';
    summary.plannedSteps = preflight.report.contract.plannedSteps.length;

    const previewReceiptIds = [];
    const executeReceiptIds = [];
    for (const stepIndex of [1, 2]) {
      const stepPreview = await action('/actions/floating-chat-tool-loop-execute', { mode: 'preview', conversationId, toolLoopRequest: loopJson, maxSteps: 3, stepIndex, maxResultChars: 12000 });
      const step = await action('/actions/floating-chat-tool-loop-execute', { mode: 'execute', conversationId, toolLoopRequest: loopJson, maxSteps: 3, stepIndex, maxResultChars: 12000, confirmation: stepPreview.preview.requiredConfirmation, previewReceiptId: stepPreview.preview.previewReceipt.id });
      previewReceiptIds.push(stepPreview.preview.previewReceipt.id);
      executeReceiptIds.push(step.executeReceipt.id);
      summary.executedSteps.push({
        stepIndex,
        ok: step.ok === true,
        tool: step.report.toolExecution.tool,
        stopReason: step.report.loopExecution.stopReason || '',
        providerCall: step.report.providerCall.performed === true,
        previewReceiptId: stepPreview.preview.previewReceipt.id,
        executeReceiptId: step.executeReceipt.id,
        reportPath: step.reportPath || '',
      });
      summary.reportPath = step.reportPath || summary.reportPath;
    }
    summary.oneStepExecuted = summary.executedSteps[0]?.ok === true && summary.executedSteps[0]?.tool === 'read-file';
    summary.boundedReadOnlyStepsExecuted = summary.executedSteps.length === 2
      && summary.executedSteps.every(step => step.ok === true)
      && summary.executedSteps.map(step => step.tool).join(',') === 'read-file,grep';
    summary.stopReason = summary.executedSteps.map(step => step.stopReason).join(' | ');
    summary.noProviderCall = summary.executedSteps.every(step => step.providerCall === false);
    summary.freshPreviewReceipts = new Set(previewReceiptIds).size === previewReceiptIds.length;
    summary.freshExecuteReceipts = new Set(executeReceiptIds).size === executeReceiptIds.length;
  } finally {
    server.kill();
  }

  const passed = summary.conversationCreated
    && summary.policyGateRecorded
    && summary.loopPreflightReady
    && summary.plannedSteps === 2
    && summary.oneStepExecuted
    && summary.boundedReadOnlyStepsExecuted
    && summary.freshPreviewReceipts
    && summary.freshExecuteReceipts
    && summary.executedSteps.every(step => step.stopReason === 'one-step-per-receipt limit')
    && summary.noProviderCall
    && summary.backendListedLoopExecute;
  const report = {
    version: 1,
    id,
    createdAt: new Date().toISOString(),
    workspace: root,
    tempWorkspace,
    tempWorkspaceKept: false,
    status: passed ? 'passed' : 'failed',
    summary,
  };
  const outDir = path.join(root, '.harmony', 'smoke');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${id}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
  fs.rmSync(tempWorkspace, { recursive: true, force: true });
  console.log(`Live operator workflow smoke: ${report.status}`);
  console.log(`Report: ${outPath}`);
  process.exitCode = passed ? 0 : 2;
}

main().catch(error => {
  fs.rmSync(tempWorkspace, { recursive: true, force: true });
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
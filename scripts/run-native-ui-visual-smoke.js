const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin', 'harmony-cli.js');
const nativeUiRoot = path.join(root, 'native-ui');
const viteBin = path.join(nativeUiRoot, 'node_modules', 'vite', 'bin', 'vite.js');
const id = `native-ui-visual-smoke-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
const tempWorkspace = path.join(os.tmpdir(), id);
const backendPort = 8890 + (process.pid % 400);
const uiPort = 1490 + (process.pid % 400);
const backendUrl = `http://127.0.0.1:${backendPort}`;
const uiUrl = `http://127.0.0.1:${uiPort}/?backend=${encodeURIComponent(backendUrl)}`;

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

function requestText(url) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(url), { method: 'GET', timeout: 5000 }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode} ${url}: ${text.slice(0, 1000)}`));
          return;
        }
        resolve(text);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`Timed out: GET ${url}`)));
    req.end();
  });
}

async function waitForUrl(url, label) {
  const deadline = Date.now() + 20000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await requestText(url);
      return;
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  throw lastError || new Error(`${label} did not become ready`);
}

function spawnLogged(command, args, cwd) {
  const child = cp.spawn(command, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', chunk => { output += String(chunk); });
  child.stderr.on('data', chunk => { output += String(chunk); });
  child.outputText = () => output;
  return child;
}

function commandWorks(command) {
  const result = cp.spawnSync(command, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  return result.status === 0;
}

function browserCandidates() {
  const candidates = [];
  if (process.env.HARMONY_BROWSER_EXECUTABLE) candidates.push(process.env.HARMONY_BROWSER_EXECUTABLE);
  if (process.platform === 'win32') {
    const programFiles = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
    for (const base of programFiles) {
      candidates.push(path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
      candidates.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
    candidates.push('msedge');
    candidates.push('chrome');
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    candidates.push('microsoft-edge');
    candidates.push('google-chrome');
    candidates.push('chromium');
  } else {
    candidates.push('microsoft-edge');
    candidates.push('msedge');
    candidates.push('google-chrome');
    candidates.push('chromium-browser');
    candidates.push('chromium');
  }
  return Array.from(new Set(candidates));
}

function findBrowser() {
  for (const candidate of browserCandidates()) {
    if (!candidate) continue;
    const looksLikePath = candidate.includes(path.sep) || candidate.includes('/');
    if (looksLikePath && fs.existsSync(candidate)) return candidate;
    if (!looksLikePath && commandWorks(candidate)) return candidate;
  }
  throw new Error('No headless Chromium-compatible browser found. Set HARMONY_BROWSER_EXECUTABLE to msedge, chrome, or chromium.');
}

function runBrowser(browser, args, label) {
  const result = cp.spawnSync(browser, args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 45000,
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit ${result.status}\n${result.stderr || result.stdout}`);
  }
  return result;
}

async function main() {
  if (!fs.existsSync(viteBin)) throw new Error(`Vite binary not found at ${viteBin}. Run npm install --prefix native-ui first.`);
  fs.mkdirSync(tempWorkspace, { recursive: true });
  runCli(['policy', 'init']);

  const backend = spawnLogged(process.execPath, [cli, '--workspace', tempWorkspace, 'ui', 'serve', '--port', String(backendPort)], root);
  const vite = spawnLogged(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], nativeUiRoot);
  const outDir = path.join(root, '.harmony', 'smoke');
  const artifactDir = path.join(outDir, 'artifacts');
  fs.mkdirSync(artifactDir, { recursive: true });
  const screenshotPath = path.join(artifactDir, `${id}.png`);

  const summary = {
    backendReady: false,
    uiReady: false,
    browser: '',
    renderedTextChecks: {},
    screenshotPath: '',
    screenshotBytes: 0,
  };

  try {
    await waitForUrl(`${backendUrl}/state`, 'backend');
    summary.backendReady = true;
    await waitForUrl(uiUrl, 'native UI');
    summary.uiReady = true;

    const browser = findBrowser();
    summary.browser = browser;
    const profileDir = path.join(os.tmpdir(), `${id}-browser-profile`);
    const baseArgs = [
      '--headless=new',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-dev-shm-usage',
      '--no-first-run',
      `--user-data-dir=${profileDir}`,
      '--virtual-time-budget=10000',
    ];
    const dom = runBrowser(browser, [...baseArgs, '--dump-dom', uiUrl], 'headless DOM render').stdout || '';
    const requiredText = [
      'Harmony Native Control',
      'Safe read-only actions',
      'Swarm Safety',
      'Default mode',
      'Risk switches default',
      'Floating Chat Tool Loop Execute',
      'Runs one approved read-only loop step per preview receipt',
      'Source-Write Preflight',
      'Report-only diff preview for a possible source edit',
      'Source-Write Execute',
      'High-risk single-file write from a recorded source-write preflight report',
      'Preview',
      'Conversation ID',
    ];
    for (const text of requiredText) summary.renderedTextChecks[text] = dom.includes(text);
    runBrowser(browser, [...baseArgs, '--window-size=1280,900', `--screenshot=${screenshotPath}`, uiUrl], 'headless screenshot');
    summary.screenshotPath = screenshotPath;
    summary.screenshotBytes = fs.existsSync(screenshotPath) ? fs.statSync(screenshotPath).size : 0;
    fs.rmSync(profileDir, { recursive: true, force: true });
  } finally {
    backend.kill();
    vite.kill();
  }

  const passed = summary.backendReady
    && summary.uiReady
    && Object.values(summary.renderedTextChecks).every(Boolean)
    && summary.screenshotBytes > 10000;
  const report = {
    version: 1,
    id,
    createdAt: new Date().toISOString(),
    workspace: root,
    tempWorkspace,
    tempWorkspaceKept: false,
    status: passed ? 'passed' : 'failed',
    summary,
    serverOutput: {
      backend: backend.outputText().slice(-4000),
      vite: vite.outputText().slice(-4000),
    },
  };
  const outPath = path.join(outDir, `${id}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
  fs.rmSync(tempWorkspace, { recursive: true, force: true });
  console.log(`Native UI visual smoke: ${report.status}`);
  console.log(`Screenshot: ${screenshotPath}`);
  console.log(`Report: ${outPath}`);
  process.exitCode = passed ? 0 : 2;
}

main().catch(error => {
  fs.rmSync(tempWorkspace, { recursive: true, force: true });
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
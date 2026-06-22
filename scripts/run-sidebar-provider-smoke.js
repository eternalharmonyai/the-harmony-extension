const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const sourcePath = path.join(root, 'src', 'sidebar.ts');
const extensionPath = path.join(root, 'src', 'extension.ts');
const chatPath = path.join(root, 'src', 'chatParticipant.ts');
const packagePath = path.join(root, 'package.json');
const id = `sidebar-provider-smoke-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;

function extractSelect(source, idName) {
  const match = source.match(new RegExp(`<select id="${idName}">([\\s\\S]*?)<\\/select>`));
  if (!match) throw new Error(`Missing select#${idName}`);
  return match[1];
}

function optionValues(selectBody) {
  return Array.from(selectBody.matchAll(/<option value="([^"]+)">/g)).map(match => match[1]);
}

function fail(failures, message) {
  failures.push(message);
}

function main() {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const extension = fs.readFileSync(extensionPath, 'utf8');
  const chat = fs.readFileSync(chatPath, 'utf8');
  const pkg = fs.readFileSync(packagePath, 'utf8');
  const profileValues = optionValues(extractSelect(source, 'profile'));
  const providerValues = optionValues(extractSelect(source, 'provider'));
  const failures = [];

  for (const expected of ['default', 'coder', 'reviewer']) {
    if (!profileValues.includes(expected)) fail(failures, `profile select missing ${expected}`);
  }
  for (const provider of ['vscode-lm', 'deepseek', 'alibaba', 'moonshot']) {
    if (!providerValues.includes(provider)) fail(failures, `provider select missing ${provider}`);
    if (profileValues.includes(provider)) fail(failures, `profile select incorrectly includes provider ${provider}`);
  }

  const setKeyIdCount = (source.match(/id="set-key"/g) || []).length;
  if (setKeyIdCount !== 1) fail(failures, `expected exactly one set-key id, found ${setKeyIdCount}`);
  if (!source.includes('direct-primary-block')) fail(failures, 'direct primary status block is missing');
  if (!source.includes("provider: $('provider').value")) fail(failures, 'set key button does not target selected provider');
  if (!source.includes('refreshInFlight') || !source.includes('refreshQueued') || !source.includes('postCurrentState')) fail(failures, 'sidebar refresh coalescing guard is missing');
  if (!source.includes('scheduleRefresh') || !source.includes('SIDEBAR_REFRESH_DELAY_MS')) fail(failures, 'sidebar refresh throttling is missing');
  if (!source.includes('Low-memory sidebar mode') || !source.includes('Harmony sidebar isolation is active') || !source.includes("sidebar.mode") || !source.includes('cappedAccountingSummary') || !pkg.includes('"default": "isolated"')) fail(failures, 'sidebar low-memory/isolation mode and payload caps are missing');
  if (!source.includes('configure-sidebar-mode') || !extension.includes('harmony.configureSidebarMode') || !extension.includes('Harmony sidebar display mode')) fail(failures, 'sidebar display mode command/menu surface is missing');
  if (!source.includes('write-oom-diagnostics') || !extension.includes('harmony.writeOomDiagnostics') || !extension.includes('OOM_DIAGNOSTIC_MAX_LOG_FILES')) fail(failures, 'OOM diagnostic report command is missing');
  if (!source.includes('enable-low-memory-safety') || !extension.includes('harmony.enableLowMemorySafetyMode') || !pkg.includes('Harmony: Enable Low-Memory Safety Mode')) fail(failures, 'low-memory safety mode command/sidebar surface is missing');
  if (!source.includes('restore-low-memory-safety') || !extension.includes('harmony.restoreLowMemorySafetySettings') || !pkg.includes('Harmony: Restore Settings Before Low-Memory Safety Mode')) fail(failures, 'low-memory safety restore command/sidebar surface is missing');
  if (!source.includes('prepare-self-update') || !extension.includes('harmony.prepareSelfUpdateCheckpoint')) fail(failures, 'self-update checkpoint command/sidebar surface is missing');
  if (!source.includes('create-seat-handoff') || !extension.includes('harmony.createSeatHandoffBundle') || !pkg.includes('Harmony: Create Seat Handoff Bundle')) fail(failures, 'seat handoff command/sidebar surface is missing');
  if (!source.includes('AbortSignal.timeout(2500)')) fail(failures, 'Hub status refresh timeout is not bounded to 2500ms');
  if (!source.includes('indexedPathCount') || source.includes('indexedPaths:')) fail(failures, 'sidebar should post Hub indexed path count, not the full indexed path list');
  if (!source.includes('providerSecretKeys') || !source.includes('secretKeyFor(provider)')) fail(failures, 'sidebar does not expose provider secret key ids as metadata');
  if (!source.includes('Import provider .env keys')) fail(failures, 'sidebar import-provider .env action is missing');
  if (!source.includes('none in VS Code Secret Storage')) fail(failures, 'sidebar direct provider missing-key text does not name VS Code Secret Storage');
  if (!source.includes('formatLatency') || !source.includes('lastDurationMs') || !source.includes('averageDurationMs')) fail(failures, 'sidebar usage rows do not surface provider latency');
  if (!source.includes('cta-chat') || !source.includes('cta-compose') || !source.includes('#2f7d4a') || !source.includes('#6c4ab6')) fail(failures, 'sidebar primary Compose/Open Chat CTA styling is missing');
  if (!extension.includes('CLI/native provider keys use Windows DPAPI or env and are separate from this status')) fail(failures, 'provider status does not distinguish extension Secret Storage from CLI/native DPAPI');
  if (!extension.includes('Import Provider Keys From .env') || !extension.includes('harmony.importProviderKeysFromEnv')) fail(failures, 'provider status does not surface the .env import command');
  if (!extension.includes('DEEPSEEK_AGENT_API_KEY') || !extension.includes('ALIBABA_AGENT_API_KEY') || !extension.includes('MOONSHOT_AGENT_API_KEY')) fail(failures, 'provider env import does not include the new agent aliases');
  if (!chat.includes('no API key is saved in VS Code Secret Storage at') || !chat.includes('Windows DPAPI store')) fail(failures, 'chat missing-key message does not explain provider key scopes');

  const report = {
    version: 1,
    id,
    createdAt: new Date().toISOString(),
    workspace: root,
    status: failures.length ? 'failed' : 'passed',
    summary: {
      profileValues,
      providerValues,
      setKeyIdCount,
      refreshCoalescing: source.includes('refreshInFlight') && source.includes('refreshQueued'),
      keyScopeMessaging: chat.includes('VS Code Secret Storage') && extension.includes('Windows DPAPI'),
      failures,
    },
  };
  const outDir = path.join(root, '.harmony', 'smoke');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${id}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

  console.log(`Sidebar provider smoke: ${report.status}`);
  console.log(`Report: ${outPath}`);
  if (failures.length) {
    for (const item of failures) console.error(`- ${item}`);
    process.exitCode = 2;
  }
}

try {
  main();
} catch (error) {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
}
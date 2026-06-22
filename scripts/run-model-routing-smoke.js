const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function pass(name, ok, details) {
  return { name, ok: !!ok, details };
}

function includesAll(text, values) {
  return values.every(value => text.includes(value));
}

function packageToolNames(pkgText) {
  const pkg = JSON.parse(pkgText);
  return (pkg.contributes?.languageModelTools ?? []).map(tool => tool.name).filter(Boolean).sort();
}

function participantToolNames(participantText) {
  const match = participantText.match(/const HARMONY_TOOL_NAMES = \[([\s\S]*?)\];/);
  if (!match) return [];
  return Array.from(match[1].matchAll(/'([^']+)'/g)).map(item => item[1]).sort();
}

function missingFrom(expected, actual) {
  return expected.filter(value => !actual.includes(value));
}

function writeReport(report) {
  const dir = path.join(root, '.harmony', 'smoke');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(dir, `model-routing-smoke-${stamp}-${process.pid}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  return reportPath;
}

function main() {
  const pkg = read('package.json');
  const providers = read('src/providers.ts');
  const extension = read('src/extension.ts');
  const participant = read('src/chatParticipant.ts');
  const sidebar = read('src/sidebar.ts');
  const guide = read('docs/provider-model-discovery.md');
  const vision = read('src/visionRouter.ts');
  const visualTools = read('src/visualTools.ts');
  const cli = read('bin/harmony-cli.js');
  const manifestToolNames = packageToolNames(pkg);
  const directHarmonyToolNames = participantToolNames(participant);
  const missingDirectTools = missingFrom(manifestToolNames, directHarmonyToolNames);
  const extraDirectTools = missingFrom(directHarmonyToolNames, manifestToolNames);

  const checks = [
    pass('package version bumped', pkg.includes('"version": "0.2.200"')),
    pass('go-live total tools (142)', manifestToolNames.length === 142, { expected: 142, actual: manifestToolNames.length }),
    pass('direct Harmony route advertises every packaged tool', manifestToolNames.length > 0 && missingDirectTools.length === 0 && extraDirectTools.length === 0, {
      manifestCount: manifestToolNames.length,
      directRouteCount: directHarmonyToolNames.length,
      missingDirectTools,
      extraDirectTools,
    }),
    pass('provider defaults are current curated set', includesAll(providers, [
      "light: 'qwen-turbo-latest'",
      "mid: 'qwen3.5-plus'",
      "heavy: 'qwen3-max'",
      "coding: 'kimi-k2.6'",
      "light: 'gemini-3.1-flash-lite'",
      "coding: 'gemini-3.5-flash'",
    ])),
    pass('primary selector exposes curated Alibaba and Kimi options', includesAll(extension, [
      'Alibaba / Qwen Turbo Latest',
      'Alibaba / Qwen3 Max',
      'Moonshot / Kimi K2.6',
      'Discover provider models live...',
    ])),
    pass('provider status exposes generic live model discovery', extension.includes('Discover Provider Models')),
    pass('model discovery guide is reachable from sidebar and command palette', includesAll(pkg + extension + sidebar + guide, [
      'Harmony: Open Model Discovery Guide',
      'harmony.openModelDiscoveryGuide',
      'openModelDiscoveryGuide',
      'Model update guide',
      'Path A: Pick A Model For Your Local Install',
      'Path B: Update Built-In Defaults For A VSIX Release',
      'What This Changes',
      'not only an Agents setting',
      'Swarm provider route',
    ])),
    pass('provider UX names routing scopes and key-store boundaries', includesAll(extension + participant + sidebar, [
      'Primary route',
      'Agents route',
      'Swarm default',
      'VS Code Secret Storage',
      'Windows DPAPI',
      'Key stores',
    ])),
    pass('chat button preserves drafts instead of replacing query text', extension.includes("executeCommand('workbench.action.chat.open')") && extension.includes("executeCommand('type', { text: '@harmony ' })") && !extension.includes("query: '@harmony '") && pkg.includes('Harmony: Open Native Chat (Preserve Draft)')),
    pass('sidebar exposes low-memory/isolation mode and caps payloads', includesAll(pkg + sidebar, [
      'harmony.sidebar.mode',
      '"default": "isolated"',
      'Harmony sidebar isolation is active',
      'Low-memory sidebar mode',
      'SIDEBAR_MAX_USAGE_ROWS',
      'SIDEBAR_MAX_FALLBACK_EVENTS',
      'cappedAccountingSummary',
      'scheduleRefresh',
    ])),
    pass('sidebar display and OOM diagnostics commands are surfaced', includesAll(pkg + extension + sidebar, [
      'Harmony: Configure Sidebar Display Mode',
      'harmony.configureSidebarMode',
      'Sidebar display mode',
      'Harmony: Write OOM Diagnostic Report',
      'harmony.writeOomDiagnostics',
      'Harmony: Enable Low-Memory Safety Mode',
      'harmony.enableLowMemorySafetyMode',
      'enable-low-memory-safety',
      'Harmony: Restore Settings Before Low-Memory Safety Mode',
      'harmony.restoreLowMemorySafetySettings',
      'restore-low-memory-safety',
      '.harmony',
      'OOM_DIAGNOSTIC_MAX_LOG_FILES',
    ])),
    pass('self-update checkpoint is package-only and surfaced', includesAll(pkg + extension + sidebar + read('scripts/run-self-update-checkpoint.js'), [
      'Harmony: Prepare Self-Update Checkpoint (No Install)',
      'harmony.prepareSelfUpdateCheckpoint',
        'self-update:checkpoint',
        'Harmony: Create Seat Handoff Bundle',
        'harmony.createSeatHandoffBundle',
      'does not install the VSIX, reload editors, call paid providers, or mutate git',
      'release-receipt',
      '--package-only',
        'self-update:handoff',
        'seat-handoff create',
        'create-seat-handoff',
    ])),
    pass('agents selector does not offer deprecated Kimi defaults', !extension.includes("modelOverride: 'kimi-k2'") && !extension.includes("modelOverride: 'kimi-latest'")),
    pass('slash aliases map deprecated Kimi aliases to K2.6', includesAll(participant, [
      "'kimi-k2': { provider: 'moonshot', model: 'kimi-k2.6' }",
      "'kimi-latest': { provider: 'moonshot', model: 'kimi-k2.6' }",
    ])),
    pass('Hub message-start prompt is wired', includesAll(participant, [
      "get<string>('hub.startOnMessage')",
      "executeCommand<boolean>('harmony.ensureHubForChat'",
    ]) && extension.includes("registerCommand('harmony.ensureHubForChat'")),
    pass('Hub wording is on-demand not launch autostart', includesAll(pkg, [
      'Harmony: Toggle HarmonyHub On-Demand Starts',
      'This does not start Hub at VS Code launch',
    ]) && sidebar.includes('Pause on-demand Hub starts')),
    pass('Gemini vision/image defaults are current', includesAll(sidebar + vision + visualTools, [
      'gemini-3.5-flash',
      'gemini-3.1-flash-lite',
      'gemini-3.1-flash-image-preview',
    ])),
    pass('CLI provider defaults are current', includesAll(cli, [
      "model: 'deepseek-v4-flash'",
      "model: 'qwen-turbo-latest'",
      "model: 'kimi-k2.6'",
      "model: 'gemini-3.1-flash-lite'",
    ])),
  ];

  const report = {
    version: 1,
    generatedAt: new Date().toISOString(),
    status: checks.every(check => check.ok) ? 'passed' : 'failed',
    checks,
  };
  const reportPath = writeReport(report);
  if (report.status !== 'passed') {
    console.error('Model routing smoke: failed');
    console.error(`Report: ${reportPath}`);
    for (const check of checks.filter(item => !item.ok)) console.error(`- FAIL ${check.name}`);
    process.exit(1);
  }
  console.log('Model routing smoke: passed');
  console.log(`Report: ${reportPath}`);
}

main();
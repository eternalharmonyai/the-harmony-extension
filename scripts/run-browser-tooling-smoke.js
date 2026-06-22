const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const id = `browser-tooling-smoke-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function fail(failures, message) {
  failures.push(message);
}

function main() {
  const visualTools = read('src/visualTools.ts');
  const pkg = read('package.json');
  const recovery = read('docs/browser-tooling-recovery.md');
  const failures = [];

  if (!visualTools.includes('let settled = false')) fail(failures, 'execFile helper is missing single-settle guard');
  if (!/try\s*{[\s\S]*?proc\s*=\s*cp\.execFile/.test(visualTools)) fail(failures, 'execFile helper does not wrap cp.execFile in try/catch');
  if (!visualTools.includes('catch (e: any)')) fail(failures, 'execFile helper is missing synchronous spawn catch');
  if (!visualTools.includes("spawn EINVAL")) fail(failures, 'Playwright repair classifier does not include spawn EINVAL');
  if (!visualTools.includes('browserFallbackPlan') || !visualTools.includes('formatBrowserFallback')) fail(failures, 'browser tools are missing Integrated Browser fallback helpers');
  if (!visualTools.includes('Integrated Browser fallback') || !visualTools.includes('open_browser_page') || !visualTools.includes('screenshot_page')) fail(failures, 'browser fallback output does not name integrated browser tools');
  if (!visualTools.includes("fallback: launchOk ? null : browserFallbackPlan")) fail(failures, 'browser health output does not include fallback plan on launch failure');
  if (!visualTools.includes("vscode.lm.registerTool('harmony_browser_health'")) fail(failures, 'browser health tool is not registered');
  if (!visualTools.includes("vscode.lm.registerTool('harmony_browser_action'")) fail(failures, 'browser action tool is not registered');
  if (!pkg.includes('harmony_browser_health') || !pkg.includes('harmony_browser_action')) fail(failures, 'browser tools are missing from package manifest');
  for (const expected of [
    'harmony_browser_health',
    'harmony_browser_action',
    'Integrated Browser fallback',
    'Playwright Cache Repair',
    'reload VS Code or Cursor',
  ]) {
    if (!recovery.includes(expected)) fail(failures, `browser recovery doc missing: ${expected}`);
  }

  const report = {
    version: 1,
    id,
    createdAt: new Date().toISOString(),
    workspace: root,
    status: failures.length ? 'failed' : 'passed',
    summary: { failures },
  };
  const outDir = path.join(root, '.harmony', 'smoke');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${id}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

  console.log(`Browser tooling smoke: ${report.status}`);
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
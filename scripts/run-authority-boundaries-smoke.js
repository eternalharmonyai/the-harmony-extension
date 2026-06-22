const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const id = `authority-boundaries-smoke-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function record(checks, name, passed, detail) {
  checks.push({ name, status: passed ? 'passed' : 'failed', detail });
}

function missing(text, needles) {
  return needles.filter(needle => !text.includes(needle));
}

function present(text, needles) {
  return needles.filter(needle => text.includes(needle));
}

function main() {
  const cli = read('bin/harmony-cli.js');
  const extension = read('src/extension.ts');
  const nativeUi = read('native-ui/src/main.ts');
  const lmTools = read('src/lmTools.ts');
  const manual = read(`HARMONY-MANUAL.${'fa'}${'mily'}.md`);
  const pkg = read('package.json');
  const checks = [];

  const tracks = [
    {
      id: 'terminal-command-authority',
      requiredManual: ['### Future Terminal Command Authority Design', 'Approved harmless command passes.', 'No source-write/provider/git/package/editor/chat authority is granted.'],
      requiredReportRoute: ['/actions/terminal-command-report', 'terminal-command-report action supports mode preview or execute'],
      forbiddenExecuteMarkers: ['/actions/terminal-command-execute', 'terminal-command-execute', 'commandTerminalCommandExecute'],
    },
    {
      id: 'provider-call-loop-authority',
      requiredManual: ['### Future Provider-Call Loop Authority Design', 'Missing-key block.', 'No source-write/terminal/git/package/editor/chat authority is granted.'],
      requiredReportRoute: ['/actions/broker-provider-report', 'broker-provider-report action supports mode preview or execute'],
      forbiddenExecuteMarkers: ['/actions/provider-call-loop-execute', 'provider-call-loop-execute', 'commandProviderCallLoopExecute'],
    },
    {
      id: 'git-mutation-authority',
      requiredManual: ['### Future Git Mutation Authority Design', 'Dirty unrelated file blocks.', 'No source-write/terminal/provider/package/editor/chat authority is granted.'],
      requiredReportRoute: ['/actions/git-safety-report', 'git-safety-report action supports mode preview or execute'],
      forbiddenExecuteMarkers: ['/actions/git-mutation-execute', 'git-mutation-execute', 'commandGitMutationExecute'],
    },
  ];

  for (const track of tracks) {
    const missingManual = missing(manual, track.requiredManual);
    record(checks, `${track.id}_manual_plan_present`, missingManual.length === 0, missingManual.length ? `missing ${missingManual.join(', ')}` : 'manual plan and smoke requirements are present');
    const missingRoute = missing(cli, track.requiredReportRoute);
    record(checks, `${track.id}_report_only_surface_present`, missingRoute.length === 0, missingRoute.length ? `missing ${missingRoute.join(', ')}` : 'report-only/native receipt surface is present');
    const forbiddenCli = present(cli, track.forbiddenExecuteMarkers);
    const forbiddenUi = present(nativeUi, track.forbiddenExecuteMarkers);
    record(checks, `${track.id}_execute_surface_absent`, forbiddenCli.length === 0 && forbiddenUi.length === 0, [...forbiddenCli, ...forbiddenUi].length ? `found ${[...forbiddenCli, ...forbiddenUi].join(', ')}` : 'no execute route/control exists yet');
  }

  record(checks, 'source_write_execute_separate_from_other_authority', manual.includes('Do not combine Source-Write Execute with terminal command, provider-call, or git-mutation authority.'), 'source-write execute remains separate from terminal/provider/git authority');
  const missingCentralFreeFallbackMarkers = missing(lmTools, [
    'fallbackPatchSafe',
    'formatFallbackResult',
    'import { fallbackPatchSafe, formatFallbackResult }',
    'CheckPythonTool',
    'harmony_check_python',
    'GetErrorsTool',
    'SymbolLocationsTool',
    'RenameSymbolTool',
    'GithubSearchTool',
    'RunTaskTool',
    'VscodeCommandTool',
  ]);
  record(checks, 'vscode_source_write_tools_have_central_free_fallback', missingCentralFreeFallbackMarkers.length === 0, missingCentralFreeFallbackMarkers.length ? `missing ${missingCentralFreeFallbackMarkers.join(', ')}` : 'harmony_edit_file and harmony_apply_patch can fall back to packaged local snapshot/write verification when Central is absent');
  const sourceWriteExecuteUiMarkers = ['/actions/source-write-execute', 'preview-source-write-execute', 'execute-source-write-execute', 'sourceWriteExecuteAction', 'source-write-execute-confirmation'];
  const missingSourceWriteExecuteUiMarkers = missing(nativeUi, sourceWriteExecuteUiMarkers);
  const forbiddenSourceWriteExecuteUiMarkers = ['terminalCommandAction =', 'providerCallAction =', 'gitMutationAction =', 'packageInstallAction =', 'editorReloadAction =', 'chatDeletionAction ='].filter(marker => nativeUi.includes(marker));
  record(checks, 'native_ui_source_write_execute_receipt_gated', missingSourceWriteExecuteUiMarkers.length === 0 && forbiddenSourceWriteExecuteUiMarkers.length === 0, missingSourceWriteExecuteUiMarkers.length ? `missing ${missingSourceWriteExecuteUiMarkers.join(', ')}` : forbiddenSourceWriteExecuteUiMarkers.length ? `found mixed authority ${forbiddenSourceWriteExecuteUiMarkers.join(', ')}` : 'native UI source-write execute surface is present and isolated');
  record(checks, 'vscode_env_import_command_present', extension.includes('harmony.importProviderKeysFromEnv') && pkg.includes('Harmony: Import Provider Keys From .env'), 'VS Code .env import command is registered and contributed');
  record(checks, 'provider_env_aliases_supported', ['DEEPSEEK_AGENT_API_KEY', 'DEEPSEEK_EXTERNAL_API_KEY', 'EXTERNAL_UI_DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEY', 'ALIBABA_AGENT_API_KEY', 'ALIBABA_EXTERNAL_API_KEY', 'ALIBABA_API_KEY', 'Alibaba_API_KEY', 'MOONSHOT_AGENT_API_KEY', 'MOONSHOT_EXTERNAL_API_KEY', 'MOONSHOT_API_KEY', 'Moonshot_API_KEY'].every(marker => cli.includes(marker) && extension.includes(marker)), 'DeepSeek/Alibaba/Moonshot agent, external, uppercase, and mixed-case aliases are supported in CLI and VS Code import paths');
  const importStart = extension.indexOf("vscode.commands.registerCommand('harmony.importProviderKeysFromEnv'");
  const importEnd = extension.indexOf('// Discover models live', importStart);
  const importRegion = importStart >= 0 ? extension.slice(importStart, importEnd > importStart ? importEnd : undefined) : '';
  const importSpecStart = extension.indexOf('const PROVIDER_ENV_IMPORTS');
  const importSpecEnd = extension.indexOf('function normalizeImportedProviderKey', importSpecStart);
  const importSpecRegion = importSpecStart >= 0 ? extension.slice(importSpecStart, importSpecEnd > importSpecStart ? importSpecEnd : undefined) : '';
  const forbiddenImportCallMarkers = ['fetch(', 'postJsonWithHeaders', 'executeTerminalAsk', 'discoverModels', 'callOpenAiCompatFromCli', 'callGeminiFromCli'].filter(marker => importRegion.includes(marker));
  record(checks, 'vscode_env_import_has_no_provider_call_path', importRegion.includes('context.secrets.store') && forbiddenImportCallMarkers.length === 0, forbiddenImportCallMarkers.length ? `found ${forbiddenImportCallMarkers.join(', ')}` : 'VS Code .env import only stores secrets and refreshes the view');
  const forbiddenImportProviders = ['gemini', 'openrouter', 'openai', 'claude'].filter(provider => importSpecRegion.includes(`provider: '${provider}'`));
  record(checks, 'vscode_env_import_scope_is_deepseek_alibaba_moonshot_only', importSpecRegion.includes("provider: 'deepseek'") && importSpecRegion.includes("provider: 'alibaba'") && importSpecRegion.includes("provider: 'moonshot'") && importSpecRegion.includes('EXTERNAL_UI_DEEPSEEK_API_KEY') && forbiddenImportProviders.length === 0, forbiddenImportProviders.length ? `unexpected providers ${forbiddenImportProviders.join(', ')}` : 'VS Code dotenv import is scoped to DeepSeek/Alibaba/Moonshot and accepts explicit external aliases without widening provider scope');
  const forbiddenSecretEchoMarkers = ['console.', 'createOutputChannel', 'clipboard', 'fs.writeFile', 'appendFile', 'showInformationMessage(value', 'showWarningMessage(value'].filter(marker => importRegion.includes(marker));
  record(checks, 'vscode_env_import_does_not_echo_secret_values', forbiddenSecretEchoMarkers.length === 0 && importRegion.includes('Values were not printed'), forbiddenSecretEchoMarkers.length ? `found ${forbiddenSecretEchoMarkers.join(', ')}` : 'import command does not log, write, copy, or message secret values');
  record(checks, 'provider_live_harness_no_network_smoke_present', cli.includes('provider-live-harness') && cli.includes('provider-live-smoke-harness-no-provider-calls') && pkg.includes('smoke:provider-live-harness'), 'dry-run Alibaba/Moonshot live harness is registered without provider calls');
  record(checks, 'provider_live_approval_plan_is_not_execute_path', cli.includes("status: 'not-approved-not-executed'") && cli.includes('requiredBeforeAnyLiveProviderCall') && cli.includes('providerCalls: false'), 'live provider approval plan is represented without execute authority');

  const report = {
    version: 1,
    id,
    createdAt: new Date().toISOString(),
    workspace: root,
    status: checks.every(check => check.status === 'passed') ? 'passed' : 'failed',
    posture: 'terminal-provider-git-authority-tracks-separated',
    checks,
  };
  const outDir = path.join(root, '.harmony', 'smoke');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${id}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

  console.log(`Authority boundaries smoke: ${report.status}`);
  console.log(`Report: ${outPath}`);
  for (const check of checks.filter(item => item.status !== 'passed')) {
    console.error(`- ${check.name}: ${check.detail}`);
  }
  process.exitCode = report.status === 'passed' ? 0 : 2;
}

try {
  main();
} catch (error) {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
}
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

async function run() {
    const extension = vscode.extensions.getExtension('harmony.harmony-extension');
    assert(extension, 'Harmony extension was not available in the extension host');
    await extension.activate();

    const commands = await vscode.commands.getCommands(true);
    assert(commands.includes('harmony.importProviderKeysFromEnv'), 'harmony.importProviderKeysFromEnv was not registered in the extension host');

    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert(workspace, 'fixture workspace was not available');
    const deepseekValue = 'fixture-deepseek-key';
    const alibabaValue = 'fixture-alibaba-key';
    const moonshotValue = 'fixture-moonshot-key';
    fs.writeFileSync(path.join(workspace, '.env'), [
        `DEEPSEEK_AGENT_API_KEY=${deepseekValue}`,
        `ALIBABA_AGENT_API_KEY=${alibabaValue}`,
        `Moonshot_API_KEY=${moonshotValue}`,
        '',
    ].join('\n'), 'utf8');

    const result = await vscode.commands.executeCommand('harmony.importProviderKeysFromEnv');
    assert(result, 'import command did not return metadata');
    assert.strictEqual(result.status, 'imported', JSON.stringify(result, null, 2));
    assert(result.imported.some((item) => /DeepSeek \(DEEPSEEK_AGENT_API_KEY\)/.test(item)), 'DeepSeek agent alias key was not imported');
    assert(result.imported.some((item) => /Alibaba \/ Qwen \(ALIBABA_AGENT_API_KEY\)/.test(item)), 'Alibaba agent alias key was not imported');
    assert(result.imported.some((item) => /Moonshot \/ Kimi \(Moonshot_API_KEY\)/.test(item)), 'Moonshot mixed-case fallback key was not imported');

    const serialized = JSON.stringify(result);
    assert(!serialized.includes(deepseekValue), 'DeepSeek secret value appeared in import metadata');
    assert(!serialized.includes(alibabaValue), 'Alibaba secret value appeared in import metadata');
    assert(!serialized.includes(moonshotValue), 'Moonshot secret value appeared in import metadata');

    const reportRoot = process.env.HARMONY_FIXTURE_REPORT_ROOT || workspace;
    const smokeDir = path.join(reportRoot, '.harmony', 'smoke');
    fs.mkdirSync(smokeDir, { recursive: true });
    const id = `vscode-provider-key-import-fixture-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
    const report = {
        version: 1,
        id,
        createdAt: new Date().toISOString(),
        workspace,
        status: 'passed',
        posture: 'vscode-secret-storage-dotenv-import-no-secret-echo',
        checks: [
            { name: 'command_registered', status: 'passed', detail: 'harmony.importProviderKeysFromEnv' },
            { name: 'deepseek_agent_alias_imported', status: 'passed', detail: 'DEEPSEEK_AGENT_API_KEY' },
            { name: 'alibaba_agent_alias_imported', status: 'passed', detail: 'ALIBABA_AGENT_API_KEY' },
            { name: 'moonshot_fallback_imported', status: 'passed', detail: 'Moonshot_API_KEY' },
            { name: 'secret_values_not_returned', status: 'passed', detail: 'metadata contains provider/env names only' },
        ],
    };
    const reportPath = path.join(smokeDir, `${id}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

    console.log(JSON.stringify({ status: report.status, reportPath: path.relative(reportRoot, reportPath), imported: result.imported }, null, 2));
}

module.exports = { run };
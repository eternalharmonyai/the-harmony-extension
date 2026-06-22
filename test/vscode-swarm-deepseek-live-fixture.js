const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const KEY_NAMES = ['HARMONY_DEEPSEEK_API_KEY', 'DEEPSEEK_AGENT_API_KEY', 'DEEPSEEK_API_KEY'];

function normalizeKey(value) {
    return String(value || '').replace(/[\u0000-\u001f\u007f]+/g, '').trim();
}

function parseDotenvEntry(line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return undefined;
    const withoutExport = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const equalsIndex = withoutExport.indexOf('=');
    if (equalsIndex <= 0) return undefined;
    const name = withoutExport.slice(0, equalsIndex).trim();
    let value = withoutExport.slice(equalsIndex + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return undefined;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    return { name, value: normalizeKey(value) };
}

function loadDeepSeekKey() {
    for (const name of KEY_NAMES) {
        const value = normalizeKey(process.env[name]);
        if (value) return { name, value, source: 'environment' };
    }
    const dotenvPath = process.env.HARMONY_REAL_DOTENV;
    if (dotenvPath && fs.existsSync(dotenvPath)) {
        const entries = fs.readFileSync(dotenvPath, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).map(parseDotenvEntry).filter(Boolean);
        for (const name of KEY_NAMES) {
            const match = entries.find((entry) => entry.name === name && entry.value);
            if (match) return { name, value: match.value, source: 'dotenv' };
        }
    }
    return undefined;
}

function workspaceRoot() {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert(folder, 'fixture did not open a workspace folder');
    return folder.uri.fsPath;
}

async function run() {
    const extension = vscode.extensions.getExtension('harmony.harmony-extension');
    assert(extension, 'Harmony extension was not available in the extension host');
    await extension.activate();

    const key = loadDeepSeekKey();
    assert(key?.value, 'DeepSeek key not found in DEEPSEEK_AGENT_API_KEY, HARMONY_DEEPSEEK_API_KEY, DEEPSEEK_API_KEY, or HARMONY_REAL_DOTENV');

    const root = workspaceRoot();
    fs.writeFileSync(path.join(root, '.env'), `DEEPSEEK_AGENT_API_KEY=${key.value}\n`, 'utf8');
    const importResult = await vscode.commands.executeCommand('harmony.importProviderKeysFromEnv');
    assert(importResult?.imported?.some((item) => /DeepSeek \(DEEPSEEK_AGENT_API_KEY\)/.test(item)), 'DeepSeek agent alias was not imported into Secret Storage');

    const cfg = vscode.workspace.getConfiguration('harmony');
    await cfg.update('swarm.defaultProvider', 'deepseek', vscode.ConfigurationTarget.Global);
    await cfg.update('swarm.defaultTier', 'coding', vscode.ConfigurationTarget.Global);
    await cfg.update('providers.deepseek.coding', 'deepseek-v4-flash', vscode.ConfigurationTarget.Global);

    const report = await vscode.commands.executeCommand('harmony.runSwarmDeepSeekLiveFixture');
    assert(report, 'live DeepSeek swarm fixture command did not return a report');
    assert.strictEqual(report.status, 'passed', JSON.stringify(report, null, 2));
    assert.strictEqual(report.providerCallsRun, 1, 'provider call count was not exactly one');
    assert.strictEqual(report.model, 'deepseek-v4-flash', 'fixture did not record deepseek-v4-flash');
    assert.strictEqual(typeof report.estimatedCostUsd, 'number', 'fixture did not record estimated provider cost');
    assert(report.estimatedCostUsd >= 0 && report.estimatedCostUsd <= report.costBudgetUsd, 'fixture estimated provider cost was outside the budget');
    assert(Array.isArray(report.budgetProof) && report.budgetProof.some((line) => line.includes('actual estimated cost')), 'fixture did not include actual cost budget proof');
    assert(!JSON.stringify(report).includes(key.value), 'fixture report contained the API key');

    console.log(JSON.stringify({
        status: report.status,
        reportPath: report.reportPath,
        provider: report.provider,
        tier: report.tier,
        model: report.model,
        providerCallsRun: report.providerCallsRun,
        estimatedCostUsd: report.estimatedCostUsd,
        costBudgetUsd: report.costBudgetUsd,
    }, null, 2));
}

module.exports = { run };
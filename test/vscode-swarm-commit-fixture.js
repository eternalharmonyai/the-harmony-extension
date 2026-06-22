const assert = require('assert');
const vscode = require('vscode');

async function run() {
    const extension = vscode.extensions.getExtension('harmony.harmony-extension');
    assert(extension, 'Harmony extension was not available in the extension host');
    await extension.activate();

    const commands = await vscode.commands.getCommands(true);
    for (const command of [
        'harmony.compose',
        'harmony.openSwarm',
        'harmony.swarmDirectControls',
        'harmony.configureSwarmDefaults'
    ]) {
        assert(commands.includes(command), `${command} was not registered in the extension host`);
    }
    await vscode.commands.executeCommand('harmony.compose');

    const report = await vscode.commands.executeCommand('harmony.runSwarmCommitFixture');
    assert(report, 'fixture command did not return a report');
    assert.strictEqual(report.status, 'passed', JSON.stringify(report, null, 2));
    assert(report.commitHash, 'fixture report did not include a commit hash');
    assert.strictEqual(report.tempRootRemoved, true, 'fixture temp workspace was not removed after success');
    assert(report.checks.some((item) => item.includes('provider-call escrow without a positive cost estimate')), 'fixture did not verify provider-call cost-estimate blocking');

    console.log(JSON.stringify({
        status: report.status,
        reportPath: report.reportPath,
        commitHash: report.commitHash,
        toolSteps: report.toolSteps.map((step) => step.tool),
    }, null, 2));
}

module.exports = { run };
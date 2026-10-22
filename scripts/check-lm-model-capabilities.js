#!/usr/bin/env node
/**
 * Behavioral capability audit for registered language model chat providers.
 *
 * Loads compiled providers in out/ with a minimal VS Code stub and verifies
 * that every model returned by provideLanguageModelChatInformation() advertises
 * capabilities.toolCalling as true or a positive number so it remains selectable
 * in Agent mode.
 *
 *   node check-lm-model-capabilities.js              (scans ../out)
 *   node check-lm-model-capabilities.js --out <dir>  (scans <dir>)
 *   node check-lm-model-capabilities.js --self-test
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const CALL = /\.registerLanguageModelChatProvider\s*\(/;

function walk(dir, out = []) {
    if (!fs.existsSync(dir)) return out;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (e.name.endsWith('.js')) out.push(p);
    }
    return out;
}

function makeStub(registered) {
    class Part { constructor(...a) { this.args = a; } }
    const noop = () => ({ dispose() {} });
    return {
        LanguageModelTextPart: Part, LanguageModelToolCallPart: Part, LanguageModelToolResultPart: Part,
        LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
        workspace: { getConfiguration: () => ({ get: () => undefined }), onDidChangeConfiguration: noop },
        lm: { registerLanguageModelChatProvider: (vendor, provider) => { registered.push({ vendor, provider }); return { dispose() {} }; } },
        commands: { registerCommand: noop },
        window: { showInformationMessage() {}, showErrorMessage() {}, showWarningMessage() {} },
        Disposable: class { constructor(f) { this.f = f; } dispose() { if (this.f) this.f(); } },
        EventEmitter: class { constructor() { this.event = noop; } fire() {} dispose() {} },
    };
}

/** Returns { ok, lines, checked }. */
async function audit(outDir) {
    const lines = [];
    const problems = [];
    const files = walk(outDir).filter((f) => { try { return CALL.test(fs.readFileSync(f, 'utf8')); } catch { return false; } });
    let checked = 0;
    for (const file of files) {
        const rel = path.relative(outDir, file);
        const registered = [];
        const stub = makeStub(registered);
        const origLoad = Module._load;
        Module._load = function (request) { return request === 'vscode' ? stub : origLoad.apply(this, arguments); };
        try {
            delete require.cache[require.resolve(file)];
            const mod = require(file);
            const context = { subscriptions: [], secrets: { get: async () => undefined, store: async () => {}, onDidChange: () => ({ dispose() {} }) },
                globalState: { get: () => undefined, update: async () => {} }, workspaceState: { get: () => undefined, update: async () => {} } };
            for (const [name, fn] of Object.entries(mod)) {
                if (typeof fn === 'function' && /^register/.test(name)) {
                    try { fn(context); } catch (e) { problems.push(`${rel}: ${name}() threw: ${e && e.message}`); }
                }
            }
        } catch (e) {
            problems.push(`${rel}: could not be loaded: ${e && e.message}`);
        } finally {
            Module._load = origLoad;
        }
        if (registered.length === 0) { problems.push(`${rel}: calls registerLanguageModelChatProvider but registered no provider when loaded — its models cannot be checked`); continue; }
        for (const { vendor, provider } of registered) {
            let models;
            try { models = await provider.provideLanguageModelChatInformation({ silent: true }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }); }
            catch (e) { problems.push(`${rel} [${vendor}]: provideLanguageModelChatInformation threw: ${e && e.message}`); continue; }
            if (!Array.isArray(models) || models.length === 0) { problems.push(`${rel} [${vendor}]: lists no models`); continue; }
            for (const m of models) {
                checked += 1;
                const tc = m && m.capabilities ? m.capabilities.toolCalling : undefined;
                const ok = tc === true || (typeof tc === 'number' && tc > 0);
                lines.push(`  ${ok ? 'ok  ' : 'FAIL'}  ${vendor}/${m && m.id}  toolCalling=${JSON.stringify(tc)}`);
                if (!ok) problems.push(`${rel} [${vendor}]: model ${m && m.id} is hidden from the Agent picker (toolCalling=${JSON.stringify(tc)})`);
            }
        }
    }
    if (files.length === 0) problems.push('no module in out/ calls registerLanguageModelChatProvider — refusing to report a pass');
    if (checked === 0 && files.length > 0) problems.push('no model was checked — refusing to report a pass');
    return { ok: problems.length === 0, lines, problems, files: files.map((f) => path.relative(outDir, f)), checked };
}

async function selfTest() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lmcap-selftest-'));
    const mod = (models, extra = '') => `${extra}const vscode = require('vscode');\nconst MODELS = [\n    ${models.join(',\n    ')}\n];\nexports.registerX = (ctx) => { ctx.subscriptions.push(vscode.lm.registerLanguageModelChatProvider('x', { provideLanguageModelChatInformation: () => MODELS })); };\n`;
    const T = "{ id: 'm', capabilities: { toolCalling: true } }";
    const cases = [
        ['four true', { 'p.js': mod([T, T, T, T]) }, true],
        ['planted false', { 'p.js': mod([T, "{ id: 'd', capabilities: { toolCalling: false } }"]) }, false],
        ['empty capabilities', { 'p.js': mod([T, "{ id: 'd', capabilities: {} }"]) }, false],
        ['comment before the value', { 'p.js': mod([T, "{ id: 'd', capabilities: { /* toolCalling: true */ toolCalling: false } }"]) }, false],
        ['quoted key', { 'p.js': mod([T, "{ id: 'd', capabilities: { 'toolCalling': false } }"]) }, false],
        ['numeric zero', { 'p.js': mod([T, "{ id: 'd', capabilities: { toolCalling: 0 } }"]) }, false],
        ['numeric limit (valid)', { 'p.js': mod(["{ id: 'a', capabilities: { toolCalling: 128 } }"]) }, true],
        ['minified false', { 'p.js': mod([T, "{id:'d',capabilities:{toolCalling:!1}}"]) }, false],
        ['minified true only (valid)', { 'p.js': mod(["{id:'a',capabilities:{toolCalling:!0}}"]) }, true],
        ['indirect constant', { 'p.js': mod([T, "{ id: 'd', capabilities: CAPS }"], 'const CAPS = { toolCalling: false };\n') }, false],
        ['nested object first', { 'p.js': mod([T, "{ id: 'd', capabilities: { meta: { a: 1 }, toolCalling: false } }"]) }, false],
        ['duplicate key', { 'p.js': mod([T, "{ id: 'd', capabilities: { toolCalling: true, toolCalling: false } }"]) }, false],
        ['capabilities missing', { 'p.js': mod([T, "{ id: 'd' }"]) }, false],
        ['template string mentions false (valid)', { 'p.js': mod([T], 'const doc = `capabilities: { toolCalling: false }`;\n') }, true],
        ['provider in a sub-folder', { 'a.js': mod([T]), 'sub/b.js': mod(["{ id: 'q', capabilities: { toolCalling: false } }"]) }, false],
        ['second file, empty capabilities', { 'a.js': mod([T]), 'b.js': mod(["{ id: 'x', capabilities: {} }"]) }, false],
        ['module calls register but registers nothing', { 'p.js': "const vscode = require('vscode');\nexports.registerX = () => { if (false) vscode.lm.registerLanguageModelChatProvider('x', {}); };\n" }, false],
        ['nothing to scan', {}, false],
    ];
    let bad = 0;
    console.log('\n[lm-capabilities] self-test (behavioral)');
    for (let i = 0; i < cases.length; i++) {
        const [label, files, wantPass] = cases[i];
        const dir = path.join(root, `c${i}`);
        fs.mkdirSync(dir, { recursive: true });
        for (const [rel, text] of Object.entries(files)) { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); }
        const r = await audit(dir);
        const good = r.ok === wantPass;
        if (!good) bad++;
        console.log(`  ${good ? 'PASS' : 'FAIL'}  ${label} → gate ${r.ok ? 'green' : 'red'} (want ${wantPass ? 'green' : 'red'})`);
    }
    fs.rmSync(root, { recursive: true, force: true });
    console.log(`\n[lm-capabilities] self-test ${bad === 0 ? 'PASSED' : 'FAILED'} (${cases.length} cases, both sides)\n`);
    return bad === 0;
}

(async () => {
    if (process.argv.includes('--self-test')) process.exit((await selfTest()) ? 0 : 1);
    const i = process.argv.indexOf('--out');
    const outDir = i > 0 ? path.resolve(process.argv[i + 1]) : path.join(__dirname, '..', 'out');
    const r = await audit(outDir);
    console.log('\n[lm-capabilities] behavioral audit');
    console.log(`  provider modules: ${r.files.join(', ') || '(none)'}`);
    for (const l of r.lines) console.log(l);
    console.log(`  models checked: ${r.checked}`);
    if (!r.ok) { for (const p of r.problems) console.log(`  FAIL  ${p}`); process.exit(1); }
    console.log('  PASS  every registered model is selectable in the Agent picker\n');
})();

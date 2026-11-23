#!/usr/bin/env node
/**
 * Gate: Harmony Studio settings parity + Harmony-chat session saves.
 *
 * Proves the four properties that were previously untrue:
 *   1. One allowlist decides what any surface may read or write, and unknown keys
 *      are rejected rather than silently accepted.
 *   2. The panel and the external Studio reach settings through the same handler,
 *      so they cannot report different values for one setting.
 *   3. The old private shadow file (.harmony/cost-shield.json) is read-only now -
 *      nothing writes it any more, so a third store cannot reappear.
 *   4. "/" in Harmony chat offers real commands, and /save shares the native
 *      chat's on-disk session format so `@harmony /resume <name>` can read it.
 *
 * Run: node scripts/check-studio-settings.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const compiledSettings = path.join(root, 'out', 'host', 'studioSettings.js');
const compiledSessions = path.join(root, 'out', 'sessions.js');
const serverSource = path.join(root, 'src', 'host', 'standaloneServer.ts');
const sessionsSource = path.join(root, 'src', 'sessions.ts');

let passed = 0;
let failed = 0;
const failures = [];

function check(label, condition, detail) {
    if (condition) {
        passed += 1;
        console.log(`  PASS  ${label}`);
    } else {
        failed += 1;
        failures.push(label + (detail ? ` — ${detail}` : ''));
        console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    }
}

function read(file) {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return '';
    }
}

function section(title) {
    console.log(`\n${title}`);
}

/**
 * sessions.ts requires 'vscode' at module scope, so it cannot be loaded under
 * plain node. This shim stands in for the host just long enough to exercise the
 * real compiled normaliser and writer - the exact functions that were wrong.
 */
function loadSessionsWithShim(rootDir) {
    const Module = require('module');
    const originalLoad = Module._load;
    const files = new Map();
    const mkUri = (p) => ({ fsPath: p, path: p.replace(/\\/g, '/'), scheme: 'file', toString: () => 'file://' + p });
    const shim = {
        Uri: { joinPath: (uri, ...parts) => mkUri(path.join(uri.fsPath, ...parts)) },
        FileType: { File: 1, Directory: 2 },
        workspace: {
            workspaceFolders: [{ uri: mkUri(rootDir) }],
            fs: {
                async createDirectory() { /* no-op */ },
                async readFile(uri) {
                    if (!files.has(uri.fsPath)) throw new Error('ENOENT');
                    return Buffer.from(files.get(uri.fsPath));
                },
                async writeFile(uri, bytes) { files.set(uri.fsPath, Buffer.from(bytes)); },
                async readDirectory(dir) {
                    const prefix = dir.fsPath + path.sep;
                    const out = [];
                    for (const key of files.keys()) {
                        if (!key.startsWith(prefix)) continue;
                        const name = key.slice(prefix.length);
                        if (!name || name.includes(path.sep)) continue;
                        out.push([name, 1]);
                    }
                    return out;
                },
            },
        },
    };
    Module._load = function (request, ...rest) {
        if (request === 'vscode') return shim;
        return originalLoad.call(this, request, ...rest);
    };
    try {
        delete require.cache[require.resolve(compiledSessions)];
        return require(compiledSessions);
    } finally {
        Module._load = originalLoad;
    }
}

async function main() {
    section('1. Shared allowlist');

    if (!fs.existsSync(compiledSettings)) {
        console.error(`\nCompiled module missing: ${compiledSettings}\nRun "npm run compile" first.`);
        process.exit(1);
    }

    const mod = require(compiledSettings);

    check('module exports the allowlist', Array.isArray(mod.STUDIO_SETTINGS) && mod.STUDIO_SETTINGS.length > 0);
    check('allowlist is curated, not everything', mod.STUDIO_SETTINGS.length <= 20, `${mod.STUDIO_SETTINGS.length} keys`);
    check('allowlist declares known keys', mod.isAllowedSettingKey('costShield.mode') === true);
    check('allowlist rejects unknown keys', mod.isAllowedSettingKey('some.arbitrary.key') === false);
    check('allowlist rejects empty key', mod.isAllowedSettingKey('') === false);

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harmony-studio-settings-'));

    section('2. Read path and origin disclosure');

    const initial = mod.readStudioSettings(tempRoot);
    check('read returns one row per allowlisted key', initial.length === mod.STUDIO_SETTINGS.length, `${initial.length} rows`);
    check(
        'every row discloses an origin',
        initial.every((row) => typeof row.origin === 'string' && row.origin.length > 0)
    );
    check(
        'unknown values are reported as unresolved, never invented',
        initial.every((row) => {
            if (row.value === null) return row.origin === 'unresolved';
            return row.origin !== 'unresolved';
        })
    );

    section('3. Write path');

    const rejectUnknown = await mod.writeStudioSetting(tempRoot, 'definitely.not.allowed', 'x');
    check('write rejects a non-allowlisted key', rejectUnknown.ok === false && /not exposed/i.test(rejectUnknown.error || ''));

    const rejectBadEnum = await mod.writeStudioSetting(tempRoot, 'costShield.mode', 'turbo');
    check('write rejects an out-of-range enum value', rejectBadEnum.ok === false);

    const goodEnum = await mod.writeStudioSetting(tempRoot, 'costShield.mode', 'manual');
    check('write accepts a valid enum value', goodEnum.ok === true && goodEnum.value === 'manual');

    const clamped = await mod.writeStudioSetting(tempRoot, 'sessions.preambleCeilingChars', 999999999);
    check('write clamps a number to its declared maximum', clamped.ok === true && clamped.value === 500000);

    const setProj = await mod.writeStudioSetting(tempRoot, 'gemini.vertexProjectId', 'my-gcp-project');
    const clearProj = await mod.writeStudioSetting(tempRoot, 'gemini.vertexProjectId', '');
    const projRow = mod.readStudioSettings(tempRoot).find((row) => row.key === 'gemini.vertexProjectId');
    check('write allows setting and clearing optional gemini.vertexProjectId back to empty string',
        setProj.ok === true && clearProj.ok === true && projRow && projRow.value === '');

    const afterWrite = mod.readStudioSettings(tempRoot);
    const modeRow = afterWrite.find((row) => row.key === 'costShield.mode');
    check('written value is read back', modeRow && modeRow.value === 'manual');
    check('read-back reports where the value came from', modeRow && modeRow.origin === 'workspace-settings');

    const mirrorPath = path.join(tempRoot, '.harmony', 'settings.json');
    check('value is mirrored to .harmony/settings.json for the headless host', fs.existsSync(mirrorPath));

    section('4. Legacy shadow store is read-only');

    const legacyPath = path.join(tempRoot, '.harmony', 'cost-shield.json');
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, JSON.stringify({ mode: 'off', workerRoute: 'gemini:light' }), 'utf8');
    fs.rmSync(mirrorPath, { force: true });

    const legacyRead = mod.readStudioSettings(tempRoot);
    const legacyMode = legacyRead.find((row) => row.key === 'costShield.mode');
    check('legacy cost-shield value still honoured', legacyMode && legacyMode.value === 'off');
    check('legacy value is labelled as legacy', legacyMode && legacyMode.origin === 'legacy-cost-shield');

    const serverText = read(serverSource);
    check(
        'standalone server no longer writes the legacy shadow file',
        !/writeFileSync\(\s*csFile/.test(serverText),
        'found a write to csFile'
    );

    section('5. One handler, both transports');

    const settingsRouteCount = (serverText.match(/pathname === '\/api\/settings'/g) || []).length;
    const webviewSettingsCount = (serverText.match(/route === '\/api\/settings'/g) || []).length;
    check('HTTP transport serves /api/settings', settingsRouteCount === 1, `${settingsRouteCount} match(es)`);
    check('webview transport serves /api/settings', webviewSettingsCount === 1, `${webviewSettingsCount} match(es)`);
    check(
        'both transports call the shared reader',
        (serverText.match(/readStudioSettings\(workspaceRoot\)/g) || []).length >= 2
    );
    check(
        'both transports call the shared writer',
        (serverText.match(/writeStudioSetting\(workspaceRoot/g) || []).length >= 2
    );
    check(
        'cost-shield route is kept as a thin alias',
        /pathname === '\/api\/settings' \|\| pathname === '\/api\/cost-shield'/.test(serverText) &&
            /route === '\/api\/settings' \|\| route === '\/api\/cost-shield'/.test(serverText)
    );

    section('6. Live refresh instead of stale UI');

    check('host subscribes to configuration changes', /onDidChangeConfiguration\(/.test(serverText));
    check('host tracks open Studio surfaces', /liveStudioWebviews/.test(serverText));
    check('host pushes settingsChanged to open surfaces', /settingsChanged/.test(serverText));
    check('page handles the settingsChanged push', /msg\.type === 'settingsChanged'/.test(serverText));
    check('page re-reads settings on focus for the external surface', /addEventListener\('focus'/.test(serverText));

    section('7. /save in Harmony chat');

    check('sessions save route exists in the server', /pathname === '\/api\/sessions\/save'/.test(serverText));
    check('webview transport also serves the save route', /route === '\/api\/sessions\/save'/.test(serverText));
    check('saves go through ONE shared writer, not two hand-written copies',
        (serverText.match(/saveChatSession\(/g) || []).length === 2,
        `${(serverText.match(/saveChatSession\(/g) || []).length} call sites`);
    check('server no longer hand-rolls turn normalisation', !/turn\?\.text \?\? ''/.test(serverText));
    check(
        'both transports still declare Harmony chat provenance',
        (serverText.match(/'harmony-chat'/g) || []).length >= 2
    );
    check(
        'SessionSource admits harmony-chat',
        /export type SessionSource =[^;]*'harmony-chat'/.test(read(sessionsSource))
    );

    if (!fs.existsSync(compiledSessions)) {
        console.error(`\nCompiled module missing: ${compiledSessions}\nRun "npm run compile" first.`);
        process.exit(1);
    }
    const saveProofRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harmony-save-proof-'));
    const sessionsMod = loadSessionsWithShim(saveProofRoot);

    // The client pushes { role, content }. The old server read only turn?.text,
    // so every real payload normalised to '' and /save said "every turn was empty".
    check(
        'writer accepts the Harmony-chat turn shape (content)',
        sessionsMod.normalizeChatTurns([{ role: 'user', content: 'hello' }]).length === 1
    );
    check(
        'writer still accepts the chat-participant turn shape (text)',
        sessionsMod.normalizeChatTurns([{ role: 'user', text: 'hello' }]).length === 1
    );
    check(
        'writer drops turns that are genuinely empty',
        sessionsMod.normalizeChatTurns([{ role: 'user', content: '   ' }, { role: 'user', text: '' }]).length === 0
    );

    const emptyThread = await sessionsMod.saveChatSession('proof-empty', [], 'harmony-chat');
    check('empty thread is refused, not written', emptyThread.ok === false);
    check(
        'empty-thread message tells the user what to do next',
        /send at least one message in this thread/.test(emptyThread.ok === false ? emptyThread.error : ''),
        emptyThread.ok === false ? emptyThread.error : ''
    );

    const roundTrip = await sessionsMod.saveChatSession(
        'proof-thread',
        [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi there' }],
        'harmony-chat'
    );
    check(
        'end-to-end save of the REAL client payload succeeds',
        roundTrip.ok === true && roundTrip.turns === 2 && roundTrip.source === 'harmony-chat',
        JSON.stringify(roundTrip)
    );
    check('slash command registry exists', /SLASH_COMMANDS/.test(serverText));
    check('slash palette renders commands', /renderSlashCommands\(/.test(serverText));
    check('slash commands dispatch before the agent loop', /handleSlashCommand\(text\)/.test(serverText));
    check('command list is a distinct palette section', /id="slashCommandList"/.test(serverText));
    check('turns now capture a real timestamp', /content: text, ts: new Date\(\)\.toISOString\(\)/.test(serverText));

    section('8. Settings UI');

    check('header exposes a Settings control', /id="toggleSettingsBtn"/.test(serverText));
    check('settings drawer markup exists', /id="settingsDrawer"/.test(serverText));
    check('settings are rendered from the returned schema', /function renderSettings\(settings\)/.test(serverText));
    check('each row displays its origin', /source: ' \+ settingOriginLabel/.test(serverText));

    fs.rmSync(tempRoot, { recursive: true, force: true });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) {
        console.log('\nFailures:');
        for (const item of failures) console.log(`  - ${item}`);
        process.exit(1);
    }
}

main().catch((err) => {
    console.error('Gate crashed:', err && err.stack ? err.stack : err);
    process.exit(1);
});

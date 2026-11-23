#!/usr/bin/env node
/**
 * Gate: Fleet Mode Sub-Option + Layout-Independent Quick-Jump Hub + Cross-Surface Parity
 *
 * Verifies:
 *   1. Coupled Orchestrate/Fleet state machine (`computeCoupledOrchestrateState` + `writeStudioSetting`):
 *      - Enabling `orchestrateMode.fleetEnabled` auto-enables parent `orchestrateMode.enabled`.
 *      - Disabling `orchestrateMode.fleetEnabled` leaves parent `orchestrateMode.enabled` intact.
 *      - Disabling parent `orchestrateMode.enabled` pauses `orchestrateMode.fleetEnabled`.
 *   2. Manifest & Bilingual Localization Parity (`package.json`, `package.nls*.json`, `locales/*.json`):
 *      - `harmony.orchestrateMode.fleetEnabled`, `harmony.sidebar.quickHubPinned`, and `/fleet` command.
 *      - Full EN + ZH key parity for `orchestrate.fleet*` and `quickHub.*`.
 *   3. Layout-Independent Quick-Jump Hub & Smart Links (`src/sidebar.ts`):
 *      - Fluid wrapping `.quick-hub-links` + sticky `#pin-quick-hub` + `#collapse-quick-hub` + `#floating-hub-btn`.
 *      - Every `data-jump="..."` target resolves to an actual `id="..."` in `src/sidebar.ts` (zero dead anchors).
 *      - Dynamic `scrollMarginTop` offset when sticky-pinned + `prefers-reduced-motion: reduce` support.
 *   4. Cross-Surface Parity (`src/chatParticipant.ts`, `src/localAgent.ts`, `src/host/standaloneServer.ts`):
 *      - `@harmony /fleet` command (`status`, `on`, `off`, `<task>`) + `modeAddendum` Fleet directive.
 *      - Harmony Chat & External `:8789` render `#fleetModeToggleBtn`, `#runFleetBtn`, and `/fleet` in `SLASH_COMMANDS`.
 *      - `handleCollabStudioRoute` (`action: 'fleet'`) rejects unsupported providers/tiers (positive security control).
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const compiledSettings = path.join(root, 'out', 'host', 'studioSettings.js');
const compiledServer = path.join(root, 'out', 'host', 'standaloneServer.js');

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

async function main() {
    console.log('\n=== check:fleet-hub ===\n');

    if (!fs.existsSync(compiledSettings) || !fs.existsSync(compiledServer)) {
        console.error('Compiled outputs missing under out/. Run "npm run compile" first.');
        process.exit(1);
    }

    const studioSettings = require(compiledSettings);
    const standaloneServer = require(compiledServer);

    // ── 1. Coupled Orchestrate/Fleet State Machine ──────────────────────────
    console.log('1. Coupled Orchestrate/Fleet state machine');
    check(
        'computeCoupledOrchestrateState is exported',
        typeof studioSettings.computeCoupledOrchestrateState === 'function'
    );

    const s1 = studioSettings.computeCoupledOrchestrateState(
        { orchestrateEnabled: false, fleetEnabled: false },
        { key: 'orchestrateMode.fleetEnabled', value: true }
    );
    check(
        'enabling Fleet Mode auto-enables parent Orchestrate Mode',
        s1.orchestrateEnabled === true && s1.fleetEnabled === true,
        JSON.stringify(s1)
    );

    const s2 = studioSettings.computeCoupledOrchestrateState(
        { orchestrateEnabled: true, fleetEnabled: true },
        { key: 'orchestrateMode.fleetEnabled', value: false }
    );
    check(
        'disabling Fleet Mode preserves parent Orchestrate Mode',
        s2.orchestrateEnabled === true && s2.fleetEnabled === false,
        JSON.stringify(s2)
    );

    const s3 = studioSettings.computeCoupledOrchestrateState(
        { orchestrateEnabled: true, fleetEnabled: true },
        { key: 'orchestrateMode.enabled', value: false }
    );
    check(
        'disabling parent Orchestrate Mode pauses Fleet Mode',
        s3.orchestrateEnabled === false && s3.fleetEnabled === false,
        JSON.stringify(s3)
    );

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harmony-fleet-hub-'));
    try {
        const w1 = await studioSettings.writeStudioSetting(tmpRoot, 'orchestrateMode.fleetEnabled', true);
        const vals1 = studioSettings.readStudioSettingValues(tmpRoot);
        check(
            'writeStudioSetting(fleetEnabled=true) persists both parent and fleet as true',
            w1.ok === true && vals1['orchestrateMode.enabled'] === true && vals1['orchestrateMode.fleetEnabled'] === true,
            JSON.stringify(vals1)
        );

        const w2 = await studioSettings.writeStudioSetting(tmpRoot, 'orchestrateMode.fleetEnabled', false);
        const vals2 = studioSettings.readStudioSettingValues(tmpRoot);
        check(
            'writeStudioSetting(fleetEnabled=false) keeps parent true while setting fleet false',
            w2.ok === true && vals2['orchestrateMode.enabled'] === true && vals2['orchestrateMode.fleetEnabled'] === false,
            JSON.stringify(vals2)
        );

        await studioSettings.writeStudioSetting(tmpRoot, 'orchestrateMode.fleetEnabled', true);
        const w3 = await studioSettings.writeStudioSetting(tmpRoot, 'orchestrateMode.enabled', false);
        const vals3 = studioSettings.readStudioSettingValues(tmpRoot);
        check(
            'writeStudioSetting(orchestrateMode.enabled=false) pauses both in .harmony/settings.json',
            w3.ok === true && vals3['orchestrateMode.enabled'] === false && vals3['orchestrateMode.fleetEnabled'] === false,
            JSON.stringify(vals3)
        );

        // Hand-edited torn settings.json must clamp fleetEnabled -> false at the read boundary
        fs.writeFileSync(
            path.join(tmpRoot, '.harmony', 'settings.json'),
            JSON.stringify({ 'harmony.orchestrateMode.enabled': false, 'harmony.orchestrateMode.fleetEnabled': true }),
            'utf8'
        );
        const valsTorn = studioSettings.readStudioSettingValues(tmpRoot);
        check(
            'readStudioSettingValues clamps torn {enabled:false, fleetEnabled:true} to fleetEnabled=false',
            valsTorn['orchestrateMode.enabled'] === false && valsTorn['orchestrateMode.fleetEnabled'] === false,
            JSON.stringify(valsTorn)
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }

    // ── 2. Manifest & Localization Parity ───────────────────────────────────
    console.log('\n2. Manifest & bilingual localization parity');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const nlsEn = JSON.parse(fs.readFileSync(path.join(root, 'package.nls.json'), 'utf8'));
    const nlsZh = JSON.parse(fs.readFileSync(path.join(root, 'package.nls.zh-cn.json'), 'utf8'));
    const locEn = JSON.parse(fs.readFileSync(path.join(root, 'locales', 'en.json'), 'utf8'));
    const locZh = JSON.parse(fs.readFileSync(path.join(root, 'locales', 'zh.json'), 'utf8'));

    const props = pkg?.contributes?.configuration?.properties || {};
    check('package.json defines harmony.orchestrateMode.fleetEnabled', Boolean(props['harmony.orchestrateMode.fleetEnabled']));
    check('package.json defines harmony.sidebar.quickHubPinned', Boolean(props['harmony.sidebar.quickHubPinned']));

    const participantCmds = pkg?.contributes?.chatParticipants?.[0]?.commands || [];
    check(
        'package.json registers @harmony /fleet slash command',
        participantCmds.some((c) => c && c.name === 'fleet')
    );

    check(
        'package.nls.json & package.nls.zh-cn.json localize fleetEnabled + quickHubPinned',
        Boolean(nlsEn['config.harmony.orchestrateMode.fleetEnabled.description']) &&
            Boolean(nlsZh['config.harmony.orchestrateMode.fleetEnabled.description']) &&
            Boolean(nlsEn['config.harmony.sidebar.quickHubPinned.description']) &&
            Boolean(nlsZh['config.harmony.sidebar.quickHubPinned.description'])
    );

    const requiredLocaleKeys = [
        'orchestrate.fleetTitle',
        'orchestrate.fleetHint',
        'orchestrate.fleetActivePill',
        'orchestrate.fleetPausedPill',
        'orchestrate.fleetExplainerSummary',
        'orchestrate.fleetConductorLine',
        'orchestrate.fleetOrchestratorLine',
        'orchestrate.fleetCollaboratorLine',
        'quickHub.title',
        'quickHub.pin',
        'quickHub.pinned',
        'quickHub.orchestrate',
        'quickHub.costShield',
        'quickHub.whisper',
        'quickHub.providers',
        'quickHub.plan',
        'quickHub.hub',
        'quickHub.top',
        'quickHub.configureOffload',
    ];
    const missingEn = requiredLocaleKeys.filter((k) => !locEn[k]);
    const missingZh = requiredLocaleKeys.filter((k) => !locZh[k]);
    check('locales/en.json has all Fleet + Quick-Jump Hub keys', missingEn.length === 0, missingEn.join(', '));
    check('locales/zh.json has all Fleet + Quick-Jump Hub keys', missingZh.length === 0, missingZh.join(', '));

    // ── 3. Sidebar Layout-Independent Quick-Jump Hub & Smart Links ──────────
    console.log('\n3. Sidebar Quick-Jump Hub & zero dead smart-links');
    const sidebarSrc = fs.readFileSync(path.join(root, 'src', 'sidebar.ts'), 'utf8');

    check('sidebar renders #sec-quick-hub navigation container', sidebarSrc.includes('id="sec-quick-hub"'));
    check('sidebar renders #pin-quick-hub sticky option + #collapse-quick-hub', sidebarSrc.includes('id="pin-quick-hub"') && sidebarSrc.includes('id="collapse-quick-hub"'));
    check('sidebar renders #floating-hub-btn scroll-return pill', sidebarSrc.includes('id="floating-hub-btn"'));
    check('sidebar renders #fleet-mode sub-option + .fleet-explainer', sidebarSrc.includes('id="fleet-mode"') && sidebarSrc.includes('class="fleet-explainer"'));
    check('Quick-Jump Hub CSS uses flex-wrap: wrap + min-width: 0 for narrow/wide resilience', /\.quick-hub-links[\s\S]*?flex-wrap:\s*wrap/.test(sidebarSrc) && /\.smart-jump[\s\S]*?min-width:\s*0/.test(sidebarSrc));
    check('jumpToSection computes dynamic scrollMarginTop when pinned and honors prefers-reduced-motion', sidebarSrc.includes('target.style.scrollMarginTop') && sidebarSrc.includes('prefers-reduced-motion: reduce'));

    const jumpTargets = Array.from(sidebarSrc.matchAll(/data-jump="([^"]+)"/g)).map((m) => m[1]);
    const uniqueTargets = Array.from(new Set(jumpTargets));
    check('sidebar declares at least 6 distinct smart-jump targets', uniqueTargets.length >= 6, uniqueTargets.join(', '));
    const deadTargets = uniqueTargets.filter((id) => !sidebarSrc.includes(`id="${id}"`));
    check('every data-jump target resolves to a real id in sidebar.ts', deadTargets.length === 0, deadTargets.join(', '));

    // ── 4. Cross-Surface Parity (@harmony, Harmony Chat, External :8789) ────
    console.log('\n4. Cross-surface Fleet invocation & security allowlisting');
    const participantSrc = fs.readFileSync(path.join(root, 'src', 'chatParticipant.ts'), 'utf8');
    const localAgentSrc = fs.readFileSync(path.join(root, 'src', 'localAgent.ts'), 'utf8');

    check(
        '@harmony handles request.command === "fleet" for status, on, off, and task decoration',
        participantSrc.includes("request.command === 'fleet'") &&
            participantSrc.includes("lower === 'status'") &&
            participantSrc.includes("lower === 'on'") &&
            participantSrc.includes("lower === 'off'") &&
            participantSrc.includes('FLEET MODE DISPATCH')
    );
    check('@harmony modeAddendum injects FLEET MODE IS ON directive', participantSrc.includes('FLEET MODE IS ON'));
    check('localAgent tool catalog exposes harmony_parallel & harmony_spawn_worker', localAgentSrc.includes('harmony_parallel(') && localAgentSrc.includes('harmony_spawn_worker('));

    const html = standaloneServer.renderStandaloneDesktopHtml(root, 201, 'tok', 'dGVzdC1ub25jZQ==');
    check('Studio / Harmony Chat HTML renders #fleetModeToggleBtn pill', html.includes('id="fleetModeToggleBtn"'));
    check('Studio / Harmony Chat HTML renders #runFleetBtn action button', html.includes('id="runFleetBtn"'));
    check('Studio / Harmony Chat SLASH_COMMANDS includes /fleet', html.includes("name: 'fleet'") && html.includes('/fleet [on | off | status | <task>]'));

    const collabTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harmony-collab-fleet-'));
    try {
        const badProv = await standaloneServer.handleCollabStudioRoute(collabTmp, {
            action: 'fleet',
            task: 'Check changes',
            provider: 'not-a-real-provider',
        });
        check(
            'handleCollabStudioRoute(action="fleet") rejects non-allowlisted provider',
            badProv.ok === false && /Unsupported Fleet Collaborator provider/i.test(badProv.error || ''),
            JSON.stringify(badProv)
        );

        const badTier = await standaloneServer.handleCollabStudioRoute(collabTmp, {
            action: 'fleet',
            task: 'Check changes',
            provider: 'deepseek',
            tier: 'ultra-expensive-invalid',
        });
        check(
            'handleCollabStudioRoute(action="fleet") rejects non-allowlisted tier',
            badTier.ok === false && /Unsupported Fleet Collaborator tier/i.test(badTier.error || ''),
            JSON.stringify(badTier)
        );

        const sanitized = standaloneServer.sanitizeFleetContextFiles(collabTmp, [
            'src/sidebar.ts',
            'README.md',
            'src/sidebar.ts',
            '../../.env',
            '%2e%2e/.env',
            'C:secret.txt',
            'notes.txt:stream',
            '.env.',
            '.env',
            '.env.local',
            '.git/config',
            'secrets/private.pem',
            '.harmony/private/terms.json',
            '/etc/passwd',
        ]);
        check(
            'sanitizeFleetContextFiles preserves legitimate deduplicated files while blocking traversal, ADS, %-encoding, trailing dots, .env*, .git, *.pem, and private paths',
            sanitized.length === 2 && sanitized[0] === 'src/sidebar.ts' && sanitized[1] === 'README.md',
            JSON.stringify(sanitized)
        );

        const lmToolsSrc = fs.readFileSync(path.join(root, 'src', 'lmTools.ts'), 'utf8');
        check(
            'SpawnWorkerTool & ParallelTool both enforce ensurePureTextAdvisorSystem (unbypassable no-DSML/no-tool guard)',
            (lmToolsSrc.match(/ensurePureTextAdvisorSystem\(/g) || []).length >= 3 &&
                lmToolsSrc.includes('NEVER emit tool calls, DSML/XML invoke blocks'),
            'ensurePureTextAdvisorSystem guard missing'
        );

        check(
            'Quick-Jump Hub pin & collapse controls expose aria-pressed and aria-expanded for accessibility',
            sidebarSrc.includes('aria-pressed="false"') &&
                sidebarSrc.includes('aria-expanded="true"') &&
                sidebarSrc.includes('aria-controls="quick-hub-links-list"')
        );
    } finally {
        fs.rmSync(collabTmp, { recursive: true, force: true });
    }

    console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
    if (failed > 0) {
        console.error('Failures:\n  - ' + failures.join('\n  - '));
        process.exit(1);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});

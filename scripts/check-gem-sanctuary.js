#!/usr/bin/env node
/**
 * Gate: Prism Sanctuary store, multi-profile JSON bundle importer, legacy fallback,
 * instruction bounds, and strict context isolation.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const compiled = path.join(root, 'out', 'prismSanctuary.js');
if (!fs.existsSync(compiled)) {
    console.error(`Compiled module missing: ${compiled}\nRun "npm run compile" first.`);
    process.exit(1);
}

const {
    PRISMS_ROOT,
    MAX_PRISM_INSTRUCTIONS_CHARS,
    isValidPrismId,
    assertValidPrismId,
    slugifyPrismName,
    prismDirFor,
    savePrism,
    loadPrism,
    listPrisms,
    savePrismThread,
    listPrismThreads,
    savePrismKnowledgeFile,
    readPrismKnowledgeContext,
    importPrismsBundle,
    buildPrismBundleTemplate,
} = require(compiled);

let pass = 0;
const failures = [];

function check(name, condition, detail) {
    if (condition) pass++;
    else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

function throws(name, fn, match) {
    try {
        fn();
        failures.push(`${name} — did not throw`);
    } catch (err) {
        const msg = (err && err.message) || String(err);
        if (match && !new RegExp(match, 'i').test(msg)) {
            failures.push(`${name} — threw "${msg}", expected /${match}/i`);
        } else {
            pass++;
        }
    }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harmony-prisms-gate-'));

try {
    // ── 1. Identity & Path Containment ─────────────────────────────────────
    check('PRISMS_ROOT is .harmony/prisms', PRISMS_ROOT === '.harmony/prisms');
    check('valid prismId accepted', isValidPrismId('alpha-specialist') === true);
    check('traversal prismId rejected', isValidPrismId('../evil') === false);
    check('uppercase prismId rejected', isValidPrismId('AlphaPrism') === false);
    throws('assertValidPrismId refuses traversal', () => assertValidPrismId('../../etc'), 'invalid prism id');
    throws('prismDirFor refuses traversal', () => prismDirFor(tmpRoot, '../escape'), 'invalid prism id');
    check('slugifyPrismName normalizes human names', slugifyPrismName('🔮 Alpha — Systems Specialist!') === 'alpha-systems-specialist');

    // ── 2. Multi-Profile Import (1 Enterprise + 2 Regular) + Provenance ────
    const enterpriseBundle = {
        profile: 'enterprise',
        accountLabel: 'Workspace Enterprise',
        prisms: [
            {
                name: 'Alpha Enterprise Specialist',
                description: 'Enterprise systems & cloud security specialist',
                systemInstructions: 'Enforce AC-5 separation of duties and zero-trust invariants.',
                knowledgeFiles: [{ name: 'architecture-invariants.pdf', mimeType: 'application/pdf' }],
                threads: [
                    {
                        threadId: 'ent-thread-1',
                        title: 'Cloud Architecture Review',
                        turns: [
                            { role: 'user', text: 'Verify endpoint isolation.' },
                            { role: 'assistant', text: 'Verified: loopback boundary enforced.' },
                        ],
                    },
                ],
            },
        ],
    };

    const regular1Bundle = {
        profile: 'regular-1',
        prisms: [
            {
                name: 'Beta Design Reviewer',
                systemInstructions: 'Guide visual storytelling and brand cohesion.',
                knowledgeFiles: ['brand-palette.md'],
            },
        ],
    };

    const regular2Bundle = {
        profile: 'regular-2',
        prisms: [
            {
                name: 'Gamma Research Indexer',
                systemInstructions: 'Synthesize peer-reviewed literature with strict provenance.',
                knowledgeFiles: ['sources-ledger.json'],
            },
        ],
    };

    const repEnt = importPrismsBundle(tmpRoot, enterpriseBundle);
    const repReg1 = importPrismsBundle(tmpRoot, regular1Bundle);
    const repReg2 = importPrismsBundle(tmpRoot, regular2Bundle);

    check('enterprise bundle imports 1 Prism with imported provenance and 1 thread',
        repEnt.importedPrisms.length === 1 && repEnt.importedPrisms[0].imported === true && repEnt.importedThreads === 1);
    check('regular-1 bundle imports 1 Prism', repReg1.importedPrisms.length === 1 && repReg1.importedPrisms[0].account === 'regular-1');
    check('regular-2 bundle imports 1 Prism', repReg2.importedPrisms.length === 1 && repReg2.importedPrisms[0].account === 'regular-2');

    const all = listPrisms(tmpRoot);
    check('all 3 Prisms across 3 profiles are listed', all.prisms.length === 3 && all.warnings.length === 0);

    const alpha = loadPrism(tmpRoot, 'alpha-enterprise-specialist');
    check('loaded Prism preserves systemInstructions and knowledgeFiles',
        alpha && alpha.account === 'enterprise' && alpha.knowledgeFiles.length === 1 && alpha.knowledgeFiles[0].name === 'architecture-invariants.pdf');

    // ── 3. Strict Context Isolation between Prisms ─────────────────────────
    savePrismThread(tmpRoot, 'beta-design-reviewer', {
        threadId: 'beta-t1',
        title: 'Nebula Theme Study',
        turns: [{ role: 'user', text: 'Design a calm slate palette.' }],
    });

    const alphaThreads = listPrismThreads(tmpRoot, 'alpha-enterprise-specialist');
    const betaThreads = listPrismThreads(tmpRoot, 'beta-design-reviewer');
    const gammaThreads = listPrismThreads(tmpRoot, 'gamma-research-indexer');

    check('Alpha has only its own thread (strict isolation)', alphaThreads.length === 1 && alphaThreads[0].threadId === 'ent-thread-1');
    check('Beta has only its own thread (strict isolation)', betaThreads.length === 1 && betaThreads[0].threadId === 'beta-t1');
    check('Gamma has 0 threads (no bleed from Alpha or Beta)', gammaThreads.length === 0);

    // ── 4. Per-Prism Knowledge Folder Ingestion & Rule #6 Disclosure ───────
    throws('savePrismKnowledgeFile refuses path traversal filename', () =>
        savePrismKnowledgeFile(tmpRoot, 'alpha-enterprise-specialist', { name: '../secret.txt', content: 'nope' }),
        'invalid knowledge file name'
    );

    const beforeK = readPrismKnowledgeContext(tmpRoot, 'alpha-enterprise-specialist');
    check('readPrismKnowledgeContext discloses missing knowledge file before local ingestion',
        beforeK.missingFiles.includes('architecture-invariants.pdf') && beforeK.text.includes('not yet placed'));

    savePrismKnowledgeFile(tmpRoot, 'alpha-enterprise-specialist', {
        name: 'architecture-invariants.pdf',
        content: 'AC-5 Separation of Duties invariant verified.',
    });
    savePrismKnowledgeFile(tmpRoot, 'alpha-enterprise-specialist', {
        name: 'long-guide.md',
        content: 'X'.repeat(1200),
    });

    const afterK = readPrismKnowledgeContext(tmpRoot, 'alpha-enterprise-specialist', { maxCharsPerFile: 500, maxTotalChars: 2000 });
    check('readPrismKnowledgeContext includes ingested files and clears missingFiles',
        afterK.includedFiles.includes('architecture-invariants.pdf')
        && afterK.includedFiles.includes('long-guide.md')
        && afterK.missingFiles.length === 0);
    check('readPrismKnowledgeContext truncates oversized file and discloses truncation (Rule #6)',
        afterK.truncatedFiles.includes('long-guide.md') && afterK.text.includes('truncated 500 chars of 1200 bytes'));
    check('knowledge folder is strictly Prism-scoped (Gamma does not see Alpha knowledge files)',
        !readPrismKnowledgeContext(tmpRoot, 'gamma-research-indexer').includedFiles.includes('long-guide.md'));

    // ── 5. Cross-Profile Same-Name Isolation, Instruction Cap, Legacy Fallback & Template ──
    importPrismsBundle(tmpRoot, {
        profile: 'enterprise',
        prisms: [{
            name: 'Shared Specialist',
            systemInstructions: 'Enterprise instructions',
            knowledgeFiles: [{ name: 'ent-only.md', content: 'enterprise note' }],
            threads: [{ threadId: 't-ent', turns: [{ role: 'user', text: 'Enterprise turn' }] }],
        }],
    });
    const dupRep = importPrismsBundle(tmpRoot, {
        profile: 'regular-1',
        prisms: [{
            name: 'Shared Specialist',
            systemInstructions: 'Regular-1 instructions',
            threads: [{ threadId: 't-reg', turns: [{ role: 'user', text: 'Regular-1 turn' }] }],
        }],
    });
    const entShared = loadPrism(tmpRoot, 'shared-specialist');
    const regShared = loadPrism(tmpRoot, 'regular-1-shared-specialist');
    check('cross-profile same-name Prisms both survive as distinct Prism IDs',
        Boolean(entShared && regShared && entShared.account === 'enterprise' && regShared.account === 'regular-1' && dupRep.warnings.length > 0));
    check('cross-profile same-name Prisms keep strictly isolated knowledge files',
        readPrismKnowledgeContext(tmpRoot, 'shared-specialist').includedFiles.includes('ent-only.md')
        && !readPrismKnowledgeContext(tmpRoot, 'regular-1-shared-specialist').includedFiles.includes('ent-only.md'));
    check('cross-profile same-name Prisms keep strictly isolated threads',
        listPrismThreads(tmpRoot, 'shared-specialist').length === 1
        && listPrismThreads(tmpRoot, 'regular-1-shared-specialist').length === 1);

    // Oversized instruction guard (Rule #6 disclosure)
    const hugeRep = importPrismsBundle(tmpRoot, {
        profile: 'custom',
        prisms: [{
            name: 'Bounded Specialist',
            systemInstructions: 'Z'.repeat(MAX_PRISM_INSTRUCTIONS_CHARS + 500),
        }],
    });
    check('oversized imported systemInstructions are bounded and disclosed via warning',
        hugeRep.importedPrisms.length === 1
        && hugeRep.importedPrisms[0].systemInstructions.length === MAX_PRISM_INSTRUCTIONS_CHARS
        && hugeRep.warnings.some((w) => w.includes('Truncated systemInstructions')));

    // Legacy .harmony/gems/<id>/gem.json fallback + thread/knowledge carry-forward on savePrism
    const legacyDir = path.join(tmpRoot, '.harmony', 'gems', 'legacy-room');
    fs.mkdirSync(path.join(legacyDir, 'threads'), { recursive: true });
    fs.mkdirSync(path.join(legacyDir, 'knowledge'), { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'gem.json'), JSON.stringify({
        gemId: 'legacy-room',
        name: 'Legacy Migrated Room',
        systemInstructions: 'Preserved across upgrade.',
        account: 'custom',
        knowledgeFiles: [{ name: 'legacy-note.md' }],
    }), 'utf8');
    fs.writeFileSync(path.join(legacyDir, 'threads', 'legacy-t1.json'), JSON.stringify({
        gemId: 'legacy-room',
        threadId: 'legacy-t1',
        title: 'Legacy Thread',
        turns: [{ role: 'user', text: 'hello' }],
    }), 'utf8');
    fs.writeFileSync(path.join(legacyDir, 'knowledge', 'legacy-note.md'), 'Legacy knowledge body', 'utf8');
    const legacyLoaded = loadPrism(tmpRoot, 'legacy-room');
    check('legacy .harmony/gems/<id>/gem.json loads transparently via loadPrism & listPrisms',
        Boolean(legacyLoaded && legacyLoaded.prismId === 'legacy-room' && listPrisms(tmpRoot).prisms.some((p) => p.prismId === 'legacy-room')));
    savePrism(tmpRoot, { prismId: 'legacy-room', name: 'Legacy Migrated Room', systemInstructions: 'Updated instructions.' });
    check('saving a migrated legacy Prism preserves legacy threads and knowledge files',
        listPrismThreads(tmpRoot, 'legacy-room').some((t) => t.threadId === 'legacy-t1')
        && readPrismKnowledgeContext(tmpRoot, 'legacy-room').includedFiles.includes('legacy-note.md'));

    // Windows reserved names (including space before dot) & binary safety
    check('Windows reserved prismId CON rejected', isValidPrismId('con') === false && isValidPrismId('nul') === false);
    throws('Windows reserved knowledge filename CON.txt refused', () =>
        savePrismKnowledgeFile(tmpRoot, 'alpha-enterprise-specialist', { name: 'CON.txt', content: 'x' }),
        'invalid knowledge file name'
    );
    throws('Windows reserved knowledge filename "CON .txt" refused', () =>
        savePrismKnowledgeFile(tmpRoot, 'alpha-enterprise-specialist', { name: 'CON .txt', content: 'x' }),
        'invalid knowledge file name'
    );
    throws('trailing-dot knowledge filename refused', () =>
        savePrismKnowledgeFile(tmpRoot, 'alpha-enterprise-specialist', { name: 'notes.', content: 'x' }),
        'invalid knowledge file name'
    );

    const binaryPdfBytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff, 0xfe, 0x42]);
    savePrismKnowledgeFile(tmpRoot, 'beta-design-reviewer', { name: 'diagram.pdf', content: binaryPdfBytes });
    const betaK = readPrismKnowledgeContext(tmpRoot, 'beta-design-reviewer');
    check('binary knowledge asset is detected and disclosed without raw null-byte injection',
        betaK.binaryFiles.includes('diagram.pdf') && betaK.text.includes('KNOWLEDGE ASSET (binary): diagram.pdf'));

    check('slugifyPrismName is deterministic for non-ASCII names',
        slugifyPrismName('🔮🌟') === slugifyPrismName('🔮🌟'));
    savePrismThread(tmpRoot, 'beta-design-reviewer', { threadId: 'part/one', turns: [{ role: 'user', text: 'slash' }] });
    savePrismThread(tmpRoot, 'beta-design-reviewer', { threadId: 'part-one', turns: [{ role: 'user', text: 'hyphen' }] });
    check('thread IDs "part/one" and "part-one" do not overwrite each other',
        listPrismThreads(tmpRoot, 'beta-design-reviewer').length === 3);
    throws('savePrismThread refuses nonexistent Prism', () =>
        savePrismThread(tmpRoot, 'nonexistent-prism', { threadId: 't1', turns: [{ role: 'user', text: 'hi' }] }),
        'nonexistent Prism'
    );

    // ── 6. Vendor-Neutral Starter JSON Template (Zero Third-Party Scraper URLs) ──
    for (const prof of ['enterprise', 'regular-1', 'regular-2']) {
        const tmpl = buildPrismBundleTemplate(prof);
        const parsed = JSON.parse(tmpl);
        check(`starter template for ${prof} is valid vendor-neutral JSON`,
            parsed.profile === prof && Array.isArray(parsed.prisms) && !/google|gemini\.google\.com/i.test(tmpl));
    }
    const prismSrc = fs.readFileSync(path.join(root, 'src', 'prismSanctuary.ts'), 'utf8');
    check('prismSanctuary.ts contains zero third-party browser scraper URLs',
        !/gemini\.google\.com|Takeout/i.test(prismSrc));
} finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
}

if (failures.length > 0) {
    console.error(`\n❌ Prism Sanctuary gate FAILED (${failures.length} failure(s), ${pass} passed):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
}
console.log(`✅ Prism Sanctuary gate passed (${pass}/${pass} assertions).`);

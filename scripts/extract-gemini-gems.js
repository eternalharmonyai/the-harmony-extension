#!/usr/bin/env node
/**
 * Harmony Prism Sanctuary Local Bundle Manager CLI
 *
 * Usage:
 *   1. Print a vendor-neutral JSON starter bundle template:
 *      node scripts/extract-gemini-gems.js --print-template --profile enterprise
 *
 *   2. Import a local `harmony-prisms-*.json` file or directory of JSON bundles:
 *      node scripts/extract-gemini-gems.js --import path/to/harmony-prisms.json --profile enterprise
 *
 *   3. List all locally housed Prisms across all profiles:
 *      node scripts/extract-gemini-gems.js --list
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const compiled = path.join(root, 'out', 'prismSanctuary.js');
if (!fs.existsSync(compiled)) {
    console.error(`Compiled module missing: ${compiled}\nRun "npm run compile" first.`);
    process.exit(1);
}

const {
    listPrisms,
    listPrismThreads,
    importPrismsBundle,
    savePrismKnowledgeFile,
    readPrismKnowledgeContext,
    buildPrismBundleTemplate,
} = require(compiled);

const args = process.argv.slice(2);
function getFlag(name, fallback) {
    const idx = args.indexOf(name);
    if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
    return fallback;
}

const profileArg = getFlag('--profile', getFlag('--account', 'enterprise'));
const profile = ['enterprise', 'regular-1', 'regular-2', 'custom'].includes(profileArg) ? profileArg : 'custom';
const workspaceRoot = getFlag('--workspace', root);

const ingestPrismId = getFlag('--ingest-knowledge', '');
const ingestDir = getFlag('--dir', '');
if (ingestPrismId && ingestDir) {
    const resolvedDir = path.resolve(ingestDir);
    if (!fs.existsSync(resolvedDir)) {
        console.error(`Knowledge source path does not exist: ${resolvedDir}`);
        process.exit(1);
    }
    const stat = fs.lstatSync(resolvedDir);
    const files = [];
    if (stat.isDirectory()) {
        for (const f of fs.readdirSync(resolvedDir)) {
            const p = path.join(resolvedDir, f);
            try {
                const st = fs.lstatSync(p);
                if (st.isFile() && !st.isSymbolicLink()) files.push(p);
            } catch { /* skip broken symlinks */ }
        }
    } else if (stat.isFile() && !stat.isSymbolicLink()) {
        files.push(resolvedDir);
    }
    let count = 0;
    let errors = 0;
    for (const file of files) {
        try {
            const content = fs.readFileSync(file);
            const ref = savePrismKnowledgeFile(workspaceRoot, ingestPrismId, {
                name: path.basename(file),
                content,
            });
            count++;
            console.log(`  📄 Ingested ${ref.name} -> ${ref.localPath}`);
        } catch (err) {
            errors++;
            console.error(`  ⚠️ Skipped ${path.basename(file)}: ${err && err.message ? err.message : String(err)}`);
        }
    }
    const ctx = readPrismKnowledgeContext(workspaceRoot, ingestPrismId);
    console.log(`Done: ${count} knowledge file(s) ingested for ${ingestPrismId} (${ctx.includedFiles.length} active, ${ctx.binaryFiles.length} binary, ${ctx.missingFiles.length} missing).`);
    process.exit(errors > 0 ? 1 : 0);
}

if (args.includes('--print-template') || args.includes('--print-script')) {
    console.log(buildPrismBundleTemplate(profile));
    process.exit(0);
}

const importTarget = getFlag('--import', '');
if (importTarget) {
    const resolved = path.resolve(importTarget);
    if (!fs.existsSync(resolved)) {
        console.error(`Import path does not exist: ${resolved}`);
        process.exit(1);
    }
    const filesToImport = [];
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
        const entries = fs.readdirSync(resolved);
        for (const entry of entries) {
            if (entry.endsWith('.json')) filesToImport.push(path.join(resolved, entry));
        }
    } else {
        filesToImport.push(resolved);
    }

    let totalPrisms = 0;
    let totalThreads = 0;
    let importFailures = 0;
    for (const file of filesToImport) {
        try {
            const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
            const report = importPrismsBundle(workspaceRoot, raw, profile);
            totalPrisms += report.importedPrisms.length;
            totalThreads += report.importedThreads;
            console.log(`Imported ${report.importedPrisms.length} Prism(s) and ${report.importedThreads} thread(s) from ${path.basename(file)}`);
            for (const p of report.importedPrisms) {
                console.log(`  🔮 ${p.prismId} (${p.name}) [${p.account}] — ${p.knowledgeFiles.length} knowledge file(s)`);
            }
            for (const w of report.warnings) {
                console.warn(`  ⚠️ ${w}`);
            }
        } catch (err) {
            importFailures++;
            console.error(`Failed to import ${file}: ${err && err.message ? err.message : String(err)}`);
        }
    }
    console.log(`\nDone: ${totalPrisms} Prism(s), ${totalThreads} thread(s) housed under .harmony/prisms/`);
    process.exit(importFailures > 0 ? 1 : 0);
}

const { prisms, warnings } = listPrisms(workspaceRoot);
console.log(`Prism Sanctuary (${prisms.length} Prism(s) in .harmony/prisms/):`);
for (const p of prisms) {
    const threads = listPrismThreads(workspaceRoot, p.prismId);
    console.log(`  🔮 ${p.prismId.padEnd(24)} | ${p.name.padEnd(24)} | profile: ${p.account.padEnd(10)} | files: ${p.knowledgeFiles.length} | threads: ${threads.length}`);
}
for (const w of warnings) {
    console.warn(`  ⚠️ ${w}`);
}

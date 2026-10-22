#!/usr/bin/env node
'use strict';

// Repo source check — READ-ONLY verification across:
//   --tree           tracked files (workspace-relative, git ls-files)
//   --history        every commit on every ref (git log -G <regex>)
//   --messages       commit subjects + bodies
//   --binary <path>  a compiled binary, scanned as ascii (latin1) AND utf16le
//   --vsix <path>    a .vsix package: entry names + entry contents
//   --all            tree + history + messages + default binary + newest vsix
//
// Terms are read from OUTSIDE the repo:
//   ${HARMONY_CHECK_TERMS_FILE:-$HOME/.harmony-checks/terms.txt}
// The current OS username is auto-detected — never hardcoded.
//
// This script never writes to the repo, never stages, commits, or pushes.
// Exit code: 0 = clean, 2 = findings, 1 = usage/IO error.

const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Shared loader for protected terms and verification policy.
const { loadProtectedTerms, verificationGate, describeSources } = require('./lib/check-terms');

const root = path.resolve(__dirname, '..');
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

// Local-only path prefixes that must NEVER be tracked. The list is read from a LOCAL
// file that is never shipped or committed, so the repository itself carries no private
// or structural path names. Default: ~/.harmony-checks/paths.txt (one
// regular expression per line), overridable with HARMONY_CHECK_PATHS_FILE.
function loadLocalOnlyPaths() {
    const file = process.env.HARMONY_CHECK_PATHS_FILE || path.join(os.homedir(), '.harmony-checks', 'paths.txt');
    const patterns = [];
    if (fs.existsSync(file)) {
        for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
            const t = line.trim();
            if (!t || t.startsWith('#')) continue;
            try { patterns.push({ re: new RegExp(t), label: 'local-only path' }); } catch { /* ignore invalid pattern */ }
        }
    }
    return { file, patterns };
}

/** Named CLI presets for common scan modes. */
const ENTRY_PRESETS = {
    commit: { tree: true },
    push: { tree: true, messages: true, history: true },
    package: { tree: true, auto: true },
    audit: { tree: true, messages: true, history: true, auto: true },
};

/**
 * Queue the newest local artifact and the bundled daemon for scanning.
 */
function addDefaultArtifacts(args) {
    const bin = 'bin/harmonyhub.exe';
    if (fs.existsSync(path.join(root, bin)) && !args.binaries.includes(bin)) args.binaries.push(bin);
    const v = newestVsix();
    if (v && !args.vsixes.includes(v)) args.vsixes.push(v);
}

function parseArgs(argv) {
    const args = { tree: false, history: false, messages: false, binaries: [], vsixes: [], json: false, all: false };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--tree') args.tree = true;
        else if (a === '--history') args.history = true;
        else if (a === '--messages') args.messages = true;
        else if (a === '--all') args.all = true;
        else if (a === '--json') args.json = true;
        else if (a === '--entry') args.entry = argv[++i];
        else if (a === '--binary') args.binaries.push(argv[++i]);
        else if (a === '--vsix') args.vsixes.push(argv[++i]);
        else throw new Error(`unknown argument: ${a}`);
    }
    return args;
}

function git(args) {
    const r = cp.spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error((r.stderr || r.stdout || `git ${args.join(' ')} failed`).trim());
    return r.stdout;
}

function escapeRegExp(value) {
    // Replacer function avoids String.replace special-pattern ($&, $1, ...) pitfalls.
    return value.replace(/[.*+?^${}()|[\]\\]/g, (match) => '\\' + match);
}

function boundaryWrap(pattern) {
    const pre = /^[A-Za-z0-9]/.test(pattern) ? '(?<![A-Za-z0-9])' : '';
    const post = /[A-Za-z0-9]$/.test(pattern) ? '(?![A-Za-z0-9])' : '';
    return `${pre}${pattern}${post}`;
}

/**
 * ERE-compatible twin of boundaryWrap, for `git log -G` (the history scan).
 *
 * git compiles -G with POSIX ERE, which has NO lookarounds, so the boundary-aware JS
 * form cannot be passed through. Passing the RAW pattern instead (the previous
 * behaviour) made history matching behave as an unescaped REGEX: a needle containing
 * metacharacters then matched unrelated text and reported history that is actually
 * clean. Expressing the boundary as an alternation keeps -G literal AND boundary-aware,
 * so the history scan finally agrees with the tree and message scans.
 */
function historyBoundaryWrap(pattern) {
    const escaped = escapeRegExp(pattern);
    const pre = /^[A-Za-z0-9]/.test(pattern) ? '(^|[^A-Za-z0-9])' : '';
    const post = /[A-Za-z0-9]$/.test(pattern) ? '([^A-Za-z0-9]|$)' : '';
    return `${pre}${escaped}${post}`;
}

function loadNeedles() {
    const loaded = loadProtectedTerms();
    const file = loaded.primaryFile;
    const username = os.userInfo().username;
    const needles = [username, ...loaded.terms];
    const missing = loaded.missing.length > 0;
    // The term list is CASE-SENSITIVE and its lines are regex patterns — matching
    // the shared git hooks (grep, no -i). The OS username is matched
    // case-insensitively as a literal. Case sensitivity is deliberate: it stops a
    // capitalized name from colliding with lowercase web-standard prefixes (such as
    // the W3C accessibility attributes) or bundled font names.
    const matchers = [{ needle: username, re: new RegExp(escapeRegExp(username), 'gi'), search: escapeRegExp(username) }];
    const seen = new Set([username]);
    const skipped = [];
    for (const pattern of needles) {
        if (seen.has(pattern)) continue;
        seen.add(pattern);
        try {
            // The global flag is REQUIRED: without it, String.match() returns only the
            // FIRST occurrence, so a term's hit COUNT caps at 1 per file and the report
            // under-states how often it appears. Detection is unaffected — one hit still
            // flags the file — so this was a reporting-magnitude bug, not a miss bug.
            // Case-sensitivity stays deliberate (no 'i' here; see the note above).
            matchers.push({ needle: pattern, re: new RegExp(boundaryWrap(pattern), 'g'), search: historyBoundaryWrap(pattern) });
        } catch {
            skipped.push(pattern);
        }
    }
    // Phrase patterns are matched case-insensitively without word boundaries
    // and apply to working-tree and VSIX scans.
    const phraseMatchers = loaded.phrases.map((phrase) => ({
        needle: phrase,
        re: new RegExp(escapeRegExp(phrase), 'gi'),
        search: escapeRegExp(phrase),
        kind: 'phrase',
    }));

    return {
        file,
        username,
        missing,
        needles: matchers.map((m) => m.needle),
        matchers,
        phraseMatchers,
        skipped,
        verified: loaded.verified,
        warnings: loaded.warnings,
        sources: loaded.sources,
    };
}

function mergeHits(target, extra) {
    for (const [needle, count] of Object.entries(extra)) target[needle] = (target[needle] || 0) + count;
    return target;
}

function scanText(text, matchers) {
    const hits = {};
    for (const m of matchers) {
        m.re.lastIndex = 0;
        const count = (text.match(m.re) || []).length;
        if (count) hits[m.needle] = count;
    }
    return hits;
}

// Binary-safe scan across both ascii (latin1) and utf16le encodings, using the
// same word-boundary matchers as text so a term never matches inside a longer word.
function scanBuffer(buf, matchers) {
    const hits = {};
    const decodings = [buf.toString('latin1'), buf.toString('utf16le')];
    for (const m of matchers) {
        let count = 0;
        for (const text of decodings) {
            m.re.lastIndex = 0;
            count += (text.match(m.re) || []).length;
        }
        if (count) hits[m.needle] = count;
    }
    return hits;
}

function hasHits(obj) {
    return Object.keys(obj).length > 0;
}

// Vendored third-party code (node_modules) is scanned for transparency, but its
// incidental strings (license text, sample data, library internals) are reported
// as informational — only hits in our OWN files count as failures.
function isThirdParty(relPath) {
    return /(^|\/)node_modules\//.test(String(relPath).replace(/\\/g, '/'));
}

function scanTree(matchers) {
    const files = git(['ls-files']).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const findings = [];
    let scanned = 0;
    // Tracked-path check: local-only directories must never be committed, whatever their
    // contents. Runs before the content loop so it is never skipped by the size filter.
    // The path list is local-only, so no path names appear in this file.
    const localOnlyPatterns = loadLocalOnlyPaths().patterns;
    for (const rel of files) {
        const norm = rel.replace(/\\/g, '/');
        const forbidden = localOnlyPatterns.find((x) => x.re.test(norm));
        if (forbidden) {
            findings.push({ path: rel, hits: { 'local-only-path': 1 }, thirdParty: false, note: forbidden.label });
        }
    }
    for (const rel of files) {
        const abs = path.join(root, rel);
        const st = fs.statSync(abs, { throwIfNoEntry: false });
        if (!st || !st.isFile() || st.size > MAX_TEXT_BYTES) continue;
        let text;
        try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
        scanned += 1;
        const hits = scanText(text, matchers);
        if (hasHits(hits)) findings.push({ path: rel, hits, thirdParty: isThirdParty(rel) });
    }
    return { scanned, findings };
}

function scanHistory(matchers) {
    const findings = [];
    for (const m of matchers) {
        // -G (not -S): history must use the SAME regex semantics as the tree and
        // message scanners. -S pickaxes the raw pattern string as a literal, so for
        // regex needles it both misses real occurrences and flags the pattern source
        // text itself (e.g. a list of patterns stored in an old script).
        const out = git(['log', '--all', '--oneline', '-G', m.search]).split(/\r?\n/).filter(Boolean);
        if (out.length) findings.push({ needle: m.needle, commits: out.length, sample: out.slice(0, 5) });
    }
    return { findings };
}

function scanMessages(matchers) {
    const raw = git(['log', '--all', '--format=%H%x1f%s%x1f%b%x1e']);
    const records = raw.split('\x1e').map((s) => s.trim()).filter(Boolean);
    const findings = [];
    for (const rec of records) {
        const [sha, subject, body] = rec.split('\x1f');
        const hits = scanText(`${subject || ''}\n${body || ''}`, matchers);
        if (hasHits(hits)) findings.push({ sha: (sha || '').slice(0, 12), hits });
    }
    return { commits: records.length, findings };
}

function scanBinaryFile(rel, matchers) {
    const abs = path.isAbsolute(rel) ? rel : path.join(root, rel);
    if (!fs.existsSync(abs)) return { path: rel, missing: true, hits: {} };
    const buf = fs.readFileSync(abs);
    return { path: rel, bytes: buf.length, hits: scanBuffer(buf, matchers) };
}

async function scanVsixFile(rel, matchers) {
    const abs = path.isAbsolute(rel) ? rel : path.join(root, rel);
    if (!fs.existsSync(abs)) return { path: rel, missing: true, hits: {} };
    let JSZip;
    try { JSZip = require('jszip'); } catch { return { path: rel, error: 'jszip not available', hits: {} }; }
    const zip = await JSZip.loadAsync(fs.readFileSync(abs));
    const hits = {};
    const nameHits = {};
    const entryFindings = [];
    let entries = 0;
    for (const [name, entry] of Object.entries(zip.files)) {
        if (entry.dir) continue;
        entries += 1;
        const buf = await entry.async('nodebuffer');
        const entryHits = scanBuffer(buf, matchers);
        const nameEntryHits = scanText(name, matchers);
        mergeHits(entryHits, nameEntryHits);
        mergeHits(hits, entryHits);
        if (hasHits(entryHits)) entryFindings.push({ name, hits: entryHits, thirdParty: isThirdParty(name) });
        if (hasHits(nameEntryHits)) nameHits[name] = nameEntryHits;
    }
    const ownFindings = entryFindings.filter((e) => !e.thirdParty);
    const thirdPartyFindings = entryFindings.filter((e) => e.thirdParty);
    return { path: rel, entries, contentsHits: hits, nameHits: Object.keys(nameHits), entryFindings, ownFindings, thirdPartyFindings };
}

function newestVsix() {
    const entries = fs.readdirSync(root).filter((f) => f.toLowerCase().endsWith('.vsix'));
    if (!entries.length) return null;
    entries.sort((a, b) => fs.statSync(path.join(root, b)).mtimeMs - fs.statSync(path.join(root, a)).mtimeMs);
    return entries[0];
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.entry) {
        const preset = ENTRY_PRESETS[args.entry];
        if (!preset) {
            throw new Error(`unknown --entry "${args.entry}" (expected: ${Object.keys(ENTRY_PRESETS).join(', ')})`);
        }
        Object.assign(args, preset);
        if (preset.auto) addDefaultArtifacts(args);
    }
    const { file, username, missing, needles, matchers, phraseMatchers, verified, warnings, sources } = loadNeedles();
    const gate = verificationGate({ verified, missing: missing ? [file] : [], primaryFile: file });

    const report = {
        generatedAt: new Date().toISOString(),
        username,
        termsFile: file,
        termsFilePresent: !missing,
        needleCount: needles.length,
        sections: {},
        status: 'passed',
    };

    const anyMode = args.all || args.tree || args.history || args.messages || args.binaries.length || args.vsixes.length;
    if (!anyMode) { args.all = true; }

    if (args.all) {
        args.tree = true;
        args.history = true;
        args.messages = true;
        addDefaultArtifacts(args);
    }

    if (args.tree) report.sections.tree = scanTree([...matchers, ...phraseMatchers]);
    if (args.history) report.sections.history = scanHistory(matchers);
    if (args.messages) report.sections.messages = scanMessages(matchers);
    if (args.binaries.length) report.sections.binaries = args.binaries.map((b) => scanBinaryFile(b, matchers));
    if (args.vsixes.length) {
        report.sections.vsixes = [];
        for (const v of args.vsixes) report.sections.vsixes.push(await scanVsixFile(v, [...matchers, ...phraseMatchers]));
    }

    // Evaluate status — only hits in OUR OWN files fail the gate. Vendored
    // third-party hits (node_modules) and the project's own license text are
    // counted separately and reported as informational.
    const s = report.sections;
    if (s.tree) {
        s.tree.ownFindings = s.tree.findings.filter((f) => !f.thirdParty);
        s.tree.thirdPartyFindings = s.tree.findings.filter((f) => f.thirdParty);
    }
    let ownFindings = 0;
    let thirdPartyFindings = 0;
    if (s.tree) { ownFindings += s.tree.ownFindings.length; thirdPartyFindings += s.tree.thirdPartyFindings.length; }
    if (s.history) ownFindings += s.history.findings.length;
    if (s.messages) ownFindings += s.messages.findings.length;
    if (s.binaries) ownFindings += s.binaries.filter((b) => hasHits(b.hits)).length;
    if (s.vsixes) {
        ownFindings += s.vsixes.reduce((n, v) => n + ((v.ownFindings || []).length), 0);
        thirdPartyFindings += s.vsixes.reduce((n, v) => n + ((v.thirdPartyFindings || []).length), 0);
    }
    report.ownFindingCount = ownFindings;
    report.thirdPartyFindingCount = thirdPartyFindings;
    report.termsVerified = verified;
    report.termsWarnings = warnings;
    // A clean scan with nothing to scan for is NOT a pass. The status and the exit code
    // differ on purpose, so a caller can never read "unchecked" as "clean".
    if (!gate.ok) report.status = 'refused-unverified';
    else if (ownFindings) report.status = 'failed';
    else report.status = 'passed';

    const outDir = path.join(root, '.harmony', 'smoke');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `repo-check-${report.generatedAt.replace(/[:.]/g, '-')}-${process.pid}.json`);
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
    report.reportPath = path.relative(root, outPath).replace(/\\/g, '/');

    if (args.json) {
        console.log(JSON.stringify(report, null, 2));
    } else {
        console.log(`Repo source check: ${report.status}`);
        console.log(`Terms file: ${file} (${missing ? 'MISSING' : 'present'}) | needs: ${needles.length} (incl. username "${username}")`);
        console.log(`Terms: ${describeSources({ verified, sources })}`);
        for (const w of warnings) console.log(`  WARNING: ${w}`);
        if (!gate.ok) console.log(gate.message);
        else if (gate.unverified) console.log(gate.message);
        if (s.tree) console.log(`Tree: ${s.tree.scanned} text files scanned, ${s.tree.ownFindings.length} own hit, ${s.tree.thirdPartyFindings.length} third-party (informational)`);
        if (s.history) console.log(`History: ${s.history.findings.length} needle(s) found in commit diffs`);
        if (s.messages) console.log(`Messages: ${s.messages.commits} commits scanned, ${s.messages.findings.length} hit`);
        if (s.binaries) s.binaries.forEach((b) => console.log(`Binary ${b.path}: ${b.missing ? 'MISSING' : hasHits(b.hits) ? 'HITS ' + JSON.stringify(b.hits) : 'clean (' + b.bytes + ' bytes)'}`));
        if (s.vsixes) s.vsixes.forEach((v) => {
            if (v.missing) { console.log(`VSIX ${v.path}: MISSING`); return; }
            if (v.error) { console.log(`VSIX ${v.path}: ${v.error}`); return; }
            const own = (v.ownFindings || []).map((e) => e.name);
            const tp = (v.thirdPartyFindings || []).length;
            console.log(`VSIX ${v.path}: ${own.length ? 'OWN HITS ' + JSON.stringify(own) : 'clean own (' + v.entries + ' entries)'}${tp ? ' | ' + tp + ' third-party (informational)' : ''}`);
        });
        console.log(`Report: ${report.reportPath}`);
    }
    // 0 = clean, 2 = findings, 3 = refused because nothing was verified.
    if (report.status === 'refused-unverified') return 3;
    return report.status === 'passed' ? 0 : 2;
}

main()
    .then((code) => { process.exitCode = code; })
    .catch((error) => { console.error(error?.message || String(error)); process.exitCode = 1; });

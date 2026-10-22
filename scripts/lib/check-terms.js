'use strict';

/**
 * check-terms.js — shared loader for protected repository hygiene terms.
 *
 * Reads protected terms and phrases from $HARMONY_CHECK_DIR (default
 * ~/.harmony-checks, files terms.txt and phrases.txt) and enforces a fail-closed
 * verification contract when the primary list is absent unless the operator
 * explicitly sets HARMONY_ALLOW_UNVERIFIED=1.
 */

const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/** Override with HARMONY_CHECK_DIR. */
function checkDir() {
    return process.env.HARMONY_CHECK_DIR || path.join(os.homedir(), '.harmony-checks');
}

/** Primary local term list. */
function primaryTermsFile() {
    return path.join(checkDir(), 'terms.txt');
}

function phrasesFile() {
    return path.join(checkDir(), 'phrases.txt');
}

/**
 * Legacy term-list locations supported with a migration warning.
 */
function legacySources() {
    const list = [
        {
            file: path.join(os.homedir(), '.harmony-hygiene', 'private-terms.txt'),
            kind: 'terms',
            why: 'legacy term-list location — migrate entries into ' + primaryTermsFile(),
        },
        {
            file: path.join(process.cwd(), '.harmony', 'private-terms.txt'),
            kind: 'terms',
            why: 'repo-local term-list location — migrate entries into ' + primaryTermsFile(),
        },
    ];
    // Optional JSON list of names and phrases from HARMONY_LEGACY_TERMS_JSON.
    const jsonList = (process.env.HARMONY_LEGACY_TERMS_JSON || '').trim();
    if (jsonList) {
        list.push({
            file: jsonList,
            kind: 'json-names-phrases',
            why: 'operator-supplied JSON list — migrate entries into ' + primaryTermsFile(),
        });
    }
    return list;
}

function readLines(file) {
    const out = [];
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch {
        return null;
    }
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        out.push(line);
    }
    return out;
}

function readJsonTerms(file) {
    let json;
    try {
        json = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
    const pick = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : []);
    return { names: pick(json.names), phrases: pick(json.phrases) };
}

/**
 * Load every protected term, with provenance.
 *
 * @returns {{
 *   terms: string[], phrases: string[], sources: object[], missing: string[],
 *   warnings: string[], verified: boolean, primaryFile: string, directory: string
 * }}
 */
function loadProtectedTerms() {
    const directory = checkDir();
    const primaryFile = primaryTermsFile();
    const sources = [];
    const missing = [];
    const warnings = [];

    const terms = [];
    const phrases = [];
    const seen = new Set();

    const addTerms = (list, layer, file) => {
        let added = 0;
        for (const term of list) {
            if (seen.has(term)) continue;
            seen.add(term);
            terms.push(term);
            added += 1;
        }
        sources.push({ layer, file, kind: 'terms', count: added });
        return added;
    };

    // ---- Primary (the only location an operator should edit) --------------------
    const primary = readLines(primaryFile);
    if (primary === null) {
        missing.push(primaryFile);
        sources.push({ layer: 'local-term', file: primaryFile, kind: 'terms', count: 0, status: 'MISSING' });
    } else {
        addTerms(primary, 'local-term', primaryFile);
    }

    // Phrases are optional: they carry prose markers, not names. Absent is not a failure.
    const phraseLines = readLines(phrasesFile());
    const phraseSource = phrasesFile();
    if (phraseLines === null) {
        sources.push({ layer: 'local-term', file: phraseSource, kind: 'phrases', count: 0, status: 'absent (optional)' });
    } else {
        for (const p of phraseLines) if (!phrases.includes(p)) phrases.push(p);
        sources.push({ layer: 'local-term', file: phraseSource, kind: 'phrases', count: phraseLines.length });
    }

    // ---- Legacy (still checked, loudly deprecated) ------------------------------
    for (const legacy of legacySources()) {
        if (legacy.kind === 'terms') {
            const lines = readLines(legacy.file);
            if (lines === null) continue;
            const added = addTerms(lines, 'legacy-term', legacy.file);
            warnings.push(`LEGACY term list still in use: ${legacy.file} (${added} new term(s)). ${legacy.why}`);
        } else {
            const parsed = readJsonTerms(legacy.file);
            if (parsed === null) continue;
            const added = addTerms(parsed.names, 'legacy-term', legacy.file);
            let addedPhrases = 0;
            for (const p of parsed.phrases) {
                if (phrases.includes(p)) continue;
                phrases.push(p);
                addedPhrases += 1;
            }
            warnings.push(
                `LEGACY term list still in use: ${legacy.file} (${added} name(s), ${addedPhrases} phrase(s)). ${legacy.why}`,
            );
        }
    }

    const verified = terms.length > 0 && !missing.includes(primaryFile);

    return { directory, primaryFile, terms, phrases, sources, missing, warnings, verified };
}

/** True when the operator has explicitly accepted an unverified run. */
function unverifiedAllowed() {
    return process.env.HARMONY_ALLOW_UNVERIFIED === '1';
}

/**
 * Decide whether the caller may report a pass.
 *
 * Returns { ok, message }. `ok:false` means the caller MUST exit non-zero: it has not
 * verified anything and saying "clean" would be a lie. `ok:true` with `message` means
 * the run is unverified but explicitly allowed — print the message, then continue.
 */
function verificationGate(result) {
    if (result.verified) {
        return { ok: true, message: null, unverified: false };
    }
    const detail = result.missing.length
        ? `no local term list at ${result.primaryFile}`
        : `the local term list at ${result.primaryFile} contains no terms`;
    if (unverifiedAllowed()) {
        return {
            ok: true,
            unverified: true,
            message:
                `UNVERIFIED — ${detail}. HARMONY_ALLOW_UNVERIFIED=1 is set, so the scan runs ` +
                'but proves NOTHING about protected terms. Do not read this as clean.',
        };
    }
    return {
        ok: false,
        unverified: true,
        message:
            `REFUSING TO REPORT A PASS — ${detail}.\n` +
            'A privacy gate with nothing to check with is not a pass.\n' +
            `Fix: create ${result.primaryFile} with one term per line,\n` +
            '     or set HARMONY_CHECK_DIR to a directory that has one,\n' +
            '     or set HARMONY_ALLOW_UNVERIFIED=1 to run anyway and print UNVERIFIED.',
    };
}

/**
 * layer 'ignore': is this repo-relative path impossible to publish?
 *
 * Uses `git check-ignore`, so .gitignore, .git/info/exclude and any nested ignore files
 * all apply with git's own semantics. A hand-rolled matcher here would drift from git and
 * silently disagree with what actually ships.
 *
 * Returns null when git cannot answer (not a repo, git missing) — the caller must treat
 * null as "unknown", not as "safe".
 */
function isIgnoredPath(relPath) {
    const r = cp.spawnSync('git', ['check-ignore', '-q', '--', relPath], {
        cwd: process.cwd(),
        windowsHide: true,
        encoding: 'utf8',
    });
    if (r.error) return null;
    // 0 = ignored, 1 = not ignored, anything else = git could not answer.
    if (r.status === 0) return true;
    if (r.status === 1) return false;
    return null;
}

/** Human-readable provenance, for the first line of any report. */
function describeSources(result) {
    const parts = result.sources.map((s) => {
        const status = s.status ? ` ${s.status}` : '';
        return `${s.kind}:${s.count}${status} [${s.layer}]`;
    });
    return `${result.verified ? 'VERIFIED' : 'UNVERIFIED'} — ${parts.join(' · ')}`;
}

module.exports = {
    checkDir,
    primaryTermsFile,
    phrasesFile,
    legacySources,
    loadProtectedTerms,
    unverifiedAllowed,
    verificationGate,
    isIgnoredPath,
    describeSources,
};

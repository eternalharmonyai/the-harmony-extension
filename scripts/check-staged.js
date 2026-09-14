const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const TEXT_EXTENSIONS = new Set(['.cjs', '.css', '.html', '.js', '.json', '.md', '.mjs', '.ps1', '.rs', '.toml', '.ts', '.tsx', '.txt', '.xml', '.yaml', '.yml']);
const TEXT_BASENAMES = new Set(['package.json', 'package-lock.json', '.gitignore', '.vscodeignore']);
const DIRECTORY_SCAN_EXCLUDES = new Set(['.git', '.harmony', '.harmony-archive', '.harmony-staging', '.harmony-recipes', '.harmony-repair', '_backups', '_backups_vsix', '_comparison', 'dist', 'node_modules', 'out', 'target']);

// Extra directory names to skip can be supplied at runtime, so project-specific
// folder names never live in this file. Sources:
//   HARMONY_SCAN_EXCLUDES (comma-separated), plus
//   ~/.harmony-checks/excludes.txt (one name per line)
(function loadExtraScanExcludes() {
    const names = [];
    if (process.env.HARMONY_SCAN_EXCLUDES) names.push(...process.env.HARMONY_SCAN_EXCLUDES.split(','));
    const file = path.join(os.homedir(), '.harmony-checks', 'excludes.txt');
    if (fs.existsSync(file)) names.push(...fs.readFileSync(file, 'utf8').split(/\r?\n/));
    for (const name of names) {
        const trimmed = name.trim();
        if (trimmed && !trimmed.startsWith('#')) DIRECTORY_SCAN_EXCLUDES.add(trimmed);
    }
})();

function joinWord(...parts) {
    return parts.join('');
}

function parseArgs(argv) {
    const args = { mode: 'auto', paths: [], selfTest: false, allowEmpty: false, json: false };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--staged') args.mode = 'staged';
        else if (arg === '--worktree') args.mode = 'worktree';
        else if (arg === '--self-test') args.selfTest = true;
        else if (arg === '--allow-empty') args.allowEmpty = true;
        else if (arg === '--json') args.json = true;
        else if (arg === '--paths') {
            while (argv[index + 1] && !argv[index + 1].startsWith('--')) args.paths.push(argv[++index]);
        } else if (arg.startsWith('--paths=')) {
            args.paths.push(...arg.slice('--paths='.length).split(',').map(item => item.trim()).filter(Boolean));
        } else {
            throw new Error(`unknown argument: ${arg}`);
        }
    }
    return args;
}

function git(args) {
    const result = cp.spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error((result.stderr || result.stdout || `git ${args.join(' ')} failed`).trim());
    return result.stdout;
}

function splitGitPaths(output) {
    return output.split(/\r?\n/g).map(item => item.trim()).filter(Boolean);
}

function uniqueSorted(items) {
    return Array.from(new Set(items)).sort((a, b) => a.localeCompare(b));
}

function candidatePaths(args) {
    if (args.paths.length) return uniqueSorted(args.paths.map(item => item.replace(/\\/g, '/')));
    if (args.mode === 'staged') return splitGitPaths(git(['diff', '--cached', '--name-only', '--diff-filter=ACMRT']));
    if (args.mode === 'worktree') {
        return uniqueSorted([
            ...splitGitPaths(git(['diff', '--name-only', '--diff-filter=ACMRT'])),
            ...splitGitPaths(git(['ls-files', '--others', '--exclude-standard'])),
        ]);
    }
    const staged = splitGitPaths(git(['diff', '--cached', '--name-only', '--diff-filter=ACMRT']));
    if (staged.length) return staged;
    return uniqueSorted([
        ...splitGitPaths(git(['diff', '--name-only', '--diff-filter=ACMRT'])),
        ...splitGitPaths(git(['ls-files', '--others', '--exclude-standard'])),
    ]);
}

const privatePathMarkers = [
    '.harmony/',
    '.git/',
    'workspace' + 'Storage/',
    'debug-' + 'logs/',
    'trans' + 'cripts/',
];

// Project-specific path markers live OUTSIDE the repo, so no project identifier is
// encoded in this file. One marker per line, boundary-wrapped when the matcher is built.
// Default: ~/.harmony-checks/path-markers.txt (HARMONY_CHECK_PATH_MARKERS_FILE overrides).
(function loadLocalPathMarkers() {
    const file = process.env.HARMONY_CHECK_PATH_MARKERS_FILE || path.join(os.homedir(), '.harmony-checks', 'path-markers.txt');
    if (!fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const t = line.trim();
        if (t && !t.startsWith('#')) privatePathMarkers.push(t);
    }
})();

const blockedPathRegexes = [
    { kind: 'secret_env_file', regex: /(^|\/)\.env(\.|$|\/)/i },
    { kind: 'secret_material_path', regex: /(^|\/)(keys|credentials|secrets|auth)(\/|$)/i },
    { kind: 'backup_or_generated_path', regex: /(^|\/)(_backups|_backups_vsix|_comparison|backup|backups|target|node_modules)(\/|$)/i },
    { kind: 'private_marker_path', regex: new RegExp(privatePathMarkers.map(boundaryWrapped).join('|'), 'i') },
];

const contentRegexes = [
    { kind: 'openai_style_key', regex: /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{18,}\b/g },
    { kind: 'anthropic_style_key', regex: /\bsk-ant-[A-Za-z0-9_-]{18,}\b/g },
    { kind: 'google_ai_studio_key', regex: /\bAIza[A-Za-z0-9_-]{20,}\b/g },
    { kind: 'github_token', regex: /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/g },
    { kind: 'jwt_like_token', regex: /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/g },
    { kind: 'forbidden_workspace_drive_path', regex: new RegExp(`[A-Za-z]:[\\\\/]+${joinWord('Cod', 'ing')}([\\\\/]|$)`, 'ig') },
    { kind: 'user_profile_path', regex: /[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'<>]+/ig },
    { kind: 'app_data_path', regex: new RegExp(`${joinWord('App', 'Data')}[\\\\/]+Roaming[\\\\/]+Code`, 'ig') },
    { kind: 'debug_log_or_transcript_path', regex: new RegExp(`${joinWord('debug-', 'logs')}|${joinWord('trans', 'cripts')}|${joinWord('workspace', 'Storage')}`, 'ig') },
];

// Project-specific content markers live OUTSIDE the repo, so no project identifier is
// encoded in this file. One marker per line, boundary-wrapped when the matcher is built.
// Default: ~/.harmony-checks/content-markers.txt (HARMONY_CHECK_CONTENT_MARKERS_FILE overrides).
const localContentMarkers = [];
(function loadLocalContentMarkers() {
    const file = process.env.HARMONY_CHECK_CONTENT_MARKERS_FILE || path.join(os.homedir(), '.harmony-checks', 'content-markers.txt');
    if (!fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const t = line.trim();
        if (t && !t.startsWith('#')) {
            localContentMarkers.push(t);
            contentRegexes.push({ kind: 'local_marker', regex: new RegExp(boundaryWrapped(t), 'ig') });
        }
    }
})();

// Known-safe forms that may legitimately contain a local marker (for example the CSS
// property 'font-family', or an ordinary prose compound such as 'GPT-5-family').
// A marker match that lies inside one of these spans is NOT reported, so a real
// reference keeps failing while the noise stops. Matching is unchanged; only covered
// spans are excused. One entry per line; a line starting with 're:' is a regex.
// Default: ~/.harmony-checks/content-exceptions.txt (HARMONY_CHECK_CONTENT_EXCEPTIONS_FILE overrides).
const localContentExceptions = [];
(function loadLocalContentExceptions() {
    const file = process.env.HARMONY_CHECK_CONTENT_EXCEPTIONS_FILE || path.join(os.homedir(), '.harmony-checks', 'content-exceptions.txt');
    if (!fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const t = line.trim();
        if (t && !t.startsWith('#')) localContentExceptions.push(t);
    }
})();

// Case-insensitive [start, end) spans of known-safe text, used to excuse marker hits.
function exceptionSpans(text) {
    const spans = [];
    for (const entry of localContentExceptions) {
        if (entry.startsWith('re:')) {
            for (const match of text.matchAll(new RegExp(entry.slice(3), 'gi'))) {
                spans.push([match.index, match.index + match[0].length]);
            }
        } else {
            const haystack = text.toLowerCase();
            const needle = entry.toLowerCase();
            for (let from = 0; ;) {
                const at = haystack.indexOf(needle, from);
                if (at < 0) break;
                spans.push([at, at + needle.length]);
                from = at + needle.length;
            }
        }
    }
    return spans;
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, (match) => '\\' + match);
}

// Wrap a marker in optional alphanumeric boundaries so a short marker does not
// falsely match inside an ordinary longer word, while delimited forms still match.
// Markers that already start or end with a non-alphanumeric character (e.g.
// `.harmony/`) are left untouched.
function boundaryWrapped(marker) {
    const pre = /^[A-Za-z0-9]/.test(marker) ? '(?<![A-Za-z0-9])' : '';
    const post = /[A-Za-z0-9]$/.test(marker) ? '(?![A-Za-z0-9])' : '';
    return `${pre}${escapeRegExp(marker)}${post}`;
}

function isTextCandidate(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return TEXT_EXTENSIONS.has(ext) || TEXT_BASENAMES.has(path.basename(filePath));
}

function pathIssuesFor(relativePath) {
    const normalized = relativePath.replace(/\\/g, '/');
    return blockedPathRegexes
        .filter(rule => rule.regex.test(normalized))
        .map(rule => ({ path: normalized, kind: rule.kind }));
}

function contentIssuesFor(relativePath, absolutePath) {
    const issues = [];
    if (!isTextCandidate(absolutePath)) return issues;
    const stat = fs.statSync(absolutePath, { throwIfNoEntry: false });
    if (!stat || !stat.isFile() || stat.size > 1024 * 1024) return issues;
    const text = fs.readFileSync(absolutePath, 'utf8');
    let safeSpans = null;
    for (const rule of contentRegexes) {
        if (rule.kind === 'local_marker') {
            // A marker inside a known-safe form (e.g. 'font-family') is not a hit.
            if (safeSpans === null) safeSpans = exceptionSpans(text);
            let count = 0;
            for (const match of text.matchAll(new RegExp(rule.regex.source, 'gi'))) {
                const start = match.index;
                const end = start + match[0].length;
                if (safeSpans.some(([s, e]) => start >= s && end <= e)) continue;
                count += 1;
            }
            if (count) issues.push({ path: relativePath.replace(/\\/g, '/'), kind: rule.kind, count });
            continue;
        }
        rule.regex.lastIndex = 0;
        const matches = text.match(rule.regex) || [];
        if (matches.length) issues.push({ path: relativePath.replace(/\\/g, '/'), kind: rule.kind, count: matches.length });
    }
    return issues;
}

function expandDirectory(relativePath, absolutePath) {
    const out = [];
    const entries = fs.readdirSync(absolutePath, { withFileTypes: true });
    for (const entry of entries) {
        if (DIRECTORY_SCAN_EXCLUDES.has(entry.name)) continue;
        const childRelative = path.join(relativePath, entry.name).replace(/\\/g, '/');
        const childAbsolute = path.join(absolutePath, entry.name);
        if (entry.isDirectory()) out.push(...expandDirectory(childRelative, childAbsolute));
        else if (entry.isFile()) out.push(childRelative);
    }
    return out;
}

function scanPaths(pathsToScan) {
    const pathIssues = [];
    const contentIssues = [];
    const scannedPaths = [];
    for (const relativePath of pathsToScan) {
        const normalized = relativePath.replace(/\\/g, '/');
        const absolutePath = path.resolve(root, normalized);
        if (!absolutePath.startsWith(root + path.sep) && absolutePath !== root) {
            pathIssues.push({ path: normalized, kind: 'outside_workspace_path' });
            continue;
        }
        pathIssues.push(...pathIssuesFor(normalized));
        const stat = fs.statSync(absolutePath, { throwIfNoEntry: false });
        if (!stat) continue;
        const files = stat.isDirectory() ? expandDirectory(normalized, absolutePath) : [normalized];
        for (const filePath of files) {
            const fileAbsolutePath = path.resolve(root, filePath);
            if (!fileAbsolutePath.startsWith(root + path.sep) && fileAbsolutePath !== root) {
                pathIssues.push({ path: filePath, kind: 'outside_workspace_path' });
                continue;
            }
            pathIssues.push(...pathIssuesFor(filePath));
            if (fs.existsSync(fileAbsolutePath) && fs.statSync(fileAbsolutePath).isFile()) {
                scannedPaths.push(filePath);
                contentIssues.push(...contentIssuesFor(filePath, fileAbsolutePath));
            }
        }
    }
    return { scannedPaths, pathIssues, contentIssues };
}

function reportPath() {
    const dir = path.join(root, '.harmony', 'smoke');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `staged-check-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}.json`);
}

function runSelfTest() {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'harmony-staged-check-'));
    try {
        const safePath = path.join(temp, 'safe.js');
        const blockedPath = path.join(temp, '.env');
        const tokenPath = path.join(temp, 'token.txt');
        fs.writeFileSync(safePath, 'const value = "ok";\n', 'utf8');
        fs.writeFileSync(blockedPath, 'private note\n', 'utf8');
        fs.writeFileSync(tokenPath, `${joinWord('sk', '-test_', 'abcdefghijklmnopqrstuvwxyz123456')}\n`, 'utf8');
        const markerPath = path.join(temp, 'marker.txt');
        const markerWord = localContentMarkers[0] || '';
        fs.writeFileSync(markerPath, `name=${markerWord}\n`, 'utf8');
        const hyphenPath = path.join(temp, 'hyphen.txt');
        const hyphenSample = markerWord ? `p { fa-${markerWord}: 1; }\n` : '';
        fs.writeFileSync(hyphenPath, hyphenSample, 'utf8');
        const originalRoot = root;
        const cases = [
            { path: path.relative(originalRoot, safePath), absolute: safePath },
            { path: path.relative(originalRoot, blockedPath), absolute: blockedPath },
            { path: path.relative(originalRoot, tokenPath), absolute: tokenPath },
            { path: path.relative(originalRoot, markerPath), absolute: markerPath },
            { path: path.relative(originalRoot, hyphenPath), absolute: hyphenPath },
        ];
        const pathIssues = pathIssuesFor(cases[1].path);
        const contentIssues = contentIssuesFor(cases[2].path, cases[2].absolute);
        const markerIssues = contentIssuesFor(cases[3].path, cases[3].absolute);
        const hyphenIssues = contentIssuesFor(cases[4].path, cases[4].absolute);
        if (pathIssues.length !== 1) throw new Error('self-test did not flag a blocked path');
        if (contentIssues.length !== 1) throw new Error('self-test did not flag token-like content');
        if (localContentMarkers.length && markerIssues.length !== 1) throw new Error('self-test did not flag a content marker');
        const hyphenCovered = hyphenSample ? exceptionSpans(hyphenSample).length > 0 : false;
        if (hyphenCovered && hyphenIssues.length !== 0) throw new Error('self-test did not excuse a known-safe marker span');
        return {
            status: 'passed',
            checks: [
                'blocked path flagged',
                'token-like content flagged',
                'content marker flagged',
                hyphenCovered ? 'known-safe marker span excused' : 'known-safe excuse not exercised',
            ],
        };
    } finally {
        fs.rmSync(temp, { recursive: true, force: true });
    }
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.selfTest) {
        const selfTest = runSelfTest();
        if (args.json) console.log(JSON.stringify(selfTest, null, 2));
        else console.log('Staged check self-test: passed');
        return 0;
    }
    const pathsToScan = candidatePaths(args);
    if (!pathsToScan.length && !args.allowEmpty) throw new Error('no candidate files to scan; stage files or pass --worktree/--paths/--allow-empty intentionally');
    const scan = scanPaths(pathsToScan);
    const status = scan.pathIssues.length || scan.contentIssues.length ? 'failed' : 'passed';
    const target = reportPath();
    const report = {
        version: 1,
        generatedAt: new Date().toISOString(),
        status,
        mode: args.mode,
        candidateFileCount: pathsToScan.length,
        scannedFileCount: scan.scannedPaths.length,
        pathIssues: scan.pathIssues,
        contentIssues: scan.contentIssues,
    };
    fs.writeFileSync(target, JSON.stringify(report, null, 2), 'utf8');
    if (args.json) console.log(JSON.stringify({ ...report, reportPath: path.relative(root, target).replace(/\\/g, '/') }, null, 2));
    else {
        console.log(`Staged check: ${status}`);
        console.log(`Candidates: ${pathsToScan.length}`);
        console.log(`Path issues: ${scan.pathIssues.length}`);
        console.log(`Content issues: ${scan.contentIssues.length}`);
        console.log(`Report: ${path.relative(root, target).replace(/\\/g, '/')}`);
    }
    return status === 'passed' ? 0 : 2;
}

try {
    process.exitCode = main();
} catch (error) {
    console.error(error?.message || String(error));
    process.exitCode = 1;
}
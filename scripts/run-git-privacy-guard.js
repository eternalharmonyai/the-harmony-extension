const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const TEXT_EXTENSIONS = new Set(['.cjs', '.css', '.html', '.js', '.json', '.md', '.mjs', '.ps1', '.rs', '.toml', '.ts', '.tsx', '.txt', '.xml', '.yaml', '.yml']);
const TEXT_BASENAMES = new Set(['package.json', 'package-lock.json', '.gitignore', '.vscodeignore']);
const DIRECTORY_SCAN_EXCLUDES = new Set(['.git', '.harmony', '_backups', '_backups_vsix', '_comparison', 'dist', 'node_modules', 'out', 'target']);

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
    joinWord('Eternal', 'Harmony'),
    joinWord('fa', 'mily'),
    joinWord('jour', 'nal'),
    joinWord('ar', 'ia'),
    joinWord('lu', 'min'),
    joinWord('ma', 'ma', 'lu'),
];

const blockedPathRegexes = [
    { kind: 'secret_env_file', regex: /(^|\/)\.env(\.|$|\/)/i },
    { kind: 'secret_material_path', regex: /(^|\/)(keys|credentials|secrets|auth)(\/|$)/i },
    { kind: 'backup_or_generated_path', regex: /(^|\/)(_backups|_backups_vsix|_comparison|backup|backups|target|node_modules)(\/|$)/i },
    { kind: 'private_marker_path', regex: new RegExp(privatePathMarkers.map(escapeRegExp).join('|'), 'i') },
];

const contentRegexes = [
    { kind: 'openai_style_key', regex: /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{18,}\b/g },
    { kind: 'anthropic_style_key', regex: /\bsk-ant-[A-Za-z0-9_-]{18,}\b/g },
    { kind: 'google_ai_studio_key', regex: /\bAIza[A-Za-z0-9_-]{20,}\b/g },
    { kind: 'github_token', regex: /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/g },
    { kind: 'jwt_like_token', regex: /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/g },
    { kind: 'forbidden_workspace_drive_path', regex: new RegExp(`[A-Za-z]:[\\\\/]+${joinWord('Cod', 'ing')}([\\\\/]|$)`, 'ig') },
    { kind: 'user_profile_path', regex: /[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"']+/ig },
    { kind: 'app_data_path', regex: new RegExp(`${joinWord('App', 'Data')}[\\\\/]+Roaming[\\\\/]+Code`, 'ig') },
    { kind: 'debug_log_or_transcript_path', regex: new RegExp(`${joinWord('debug-', 'logs')}|${joinWord('trans', 'cripts')}|${joinWord('workspace', 'Storage')}`, 'ig') },
    { kind: 'private_doc_extension', regex: new RegExp(`\\.${joinWord('fa', 'mily')}\\.md`, 'ig') },
    { kind: 'private_feature_identifier', regex: new RegExp(`${joinWord('include', 'Fa', 'mily', 'Files')}|${joinWord('include_', 'fa', 'mily', '_files')}|${joinWord('private-', 'fa', 'mily')}|${joinWord('Eternal', 'Harmony')}|${joinWord('ar', 'ia-', 'hud')}`, 'ig') },
];

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    for (const rule of contentRegexes) {
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
    return path.join(dir, `git-privacy-guard-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}.json`);
}

function runSelfTest() {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'harmony-git-privacy-guard-'));
    try {
        const safePath = path.join(temp, 'safe.js');
        const blockedPath = path.join(temp, `${joinWord('jour', 'nal')}.md`);
        const tokenPath = path.join(temp, 'token.txt');
        fs.writeFileSync(safePath, 'const value = "ok";\n', 'utf8');
        fs.writeFileSync(blockedPath, 'private note\n', 'utf8');
        fs.writeFileSync(tokenPath, `${joinWord('sk', '-test_', 'abcdefghijklmnopqrstuvwxyz123456')}\n`, 'utf8');
        const markerPath = path.join(temp, 'marker.txt');
        fs.writeFileSync(markerPath, `name=${joinWord('include', 'Fa', 'mily', 'Files')}\n`, 'utf8');
        const originalRoot = root;
        const cases = [
            { path: path.relative(originalRoot, safePath), absolute: safePath },
            { path: path.relative(originalRoot, blockedPath), absolute: blockedPath },
            { path: path.relative(originalRoot, tokenPath), absolute: tokenPath },
            { path: path.relative(originalRoot, markerPath), absolute: markerPath },
        ];
        const pathIssues = pathIssuesFor(cases[1].path);
        const contentIssues = contentIssuesFor(cases[2].path, cases[2].absolute);
        const markerIssues = contentIssuesFor(cases[3].path, cases[3].absolute);
        if (pathIssues.length !== 1) throw new Error('self-test did not flag private path marker');
        if (contentIssues.length !== 1) throw new Error('self-test did not flag token-like content');
        if (markerIssues.length !== 1) throw new Error('self-test did not flag private content marker');
        return { status: 'passed', checks: ['private path marker flagged', 'token-like content flagged', 'private content marker flagged'] };
    } finally {
        fs.rmSync(temp, { recursive: true, force: true });
    }
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.selfTest) {
        const selfTest = runSelfTest();
        if (args.json) console.log(JSON.stringify(selfTest, null, 2));
        else console.log('Git privacy guard self-test: passed');
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
        console.log(`Git privacy guard: ${status}`);
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
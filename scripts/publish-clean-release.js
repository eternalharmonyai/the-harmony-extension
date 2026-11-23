#!/usr/bin/env node
'use strict';
/**
 * Enterprise Clean Public Release Publisher (`ehai` / `gitee`)
 *
 * Architecture:
 *  - Preserves 100% of full granular engineering history on `origin` (HARD-BLOCKED from rewrite).
 *  - Preserves 100% of cleaned public release history on `ehai` / `gitee` by appending
 *    EXACTLY ONE squashed release commit (`Harmony Extension v<version>`) on top of the
 *    verified public baseline commit (`parentCount + 1`), NEVER wiping history to 1 commit!
 *  - Stages ONLY the ancestor chain of the public baseline + the exact tracked `HEAD` tree
 *    inside an isolated temporary repository so intermediate dev commits never enter public history.
 *  - Runs `scripts/check-repo.js --entry push` across ALL `N + 1` commits (tree + history + messages)
 *    before pushing a single byte.
 *  - Defaults to `--dry-run` (safe verification receipt). Pass `--push` to publish to public remotes.
 *
 * Usage:
 *   node scripts/publish-clean-release.js                              # dry-run verification
 *   node scripts/publish-clean-release.js --parent 5904bbb --remotes ehai --push
 *   node scripts/publish-clean-release.js --remotes gitee --push
 */

const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FORBIDDEN_REMOTES = new Set(['origin']);
const ALLOWED_CLEAN_RELEASE_REMOTES = new Set(['ehai', 'gitee']);
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SAFE_REF_RE = /^[A-Za-z0-9._/-]+$/;
const HEX_SHA_RE = /^[0-9a-f]{7,40}$/i;

function normalizeGitUrl(u) {
  return String(u || '').trim().toLowerCase().replace(/\.git$/i, '').replace(/\/+$/, '');
}

function execGit(args, cwd = ROOT, isolated = false) {
  const fullArgs = isolated
    ? ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'core.hooksPath=', ...args]
    : args;
  return cp.execFileSync('git', fullArgs, {
    cwd,
    encoding: 'utf8',
    env: isolated ? { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } : process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function parseArgs(argv) {
  let push = false;
  let overwriteTag = false;
  let forceRealign = false;
  let parentRef = '';
  let remotes = ['ehai', 'gitee'];
  let branch = 'main';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--push') push = true;
    else if (a === '--overwrite-tag') overwriteTag = true;
    else if (a === '--force-realign') forceRealign = true;
    else if (a === '--dry-run') push = false;
    else if (a === '--parent' && argv[i + 1]) {
      parentRef = argv[++i].trim();
    } else if (a === '--remotes' && argv[i + 1]) {
      remotes = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a === '--branch' && argv[i + 1]) {
      branch = argv[++i].trim();
    }
  }
  return { push, overwriteTag, forceRealign, parentRef, remotes, branch };
}

function resolvePublicParentSha(explicitParent, remotes, branch) {
  if (explicitParent) {
    if (!SAFE_REF_RE.test(explicitParent) && !HEX_SHA_RE.test(explicitParent)) {
      throw new Error(`Unsafe --parent ref "${explicitParent}"`);
    }
    return execGit(['rev-parse', `${explicitParent}^{commit}`]);
  }
  // Prefer local remote-tracking refs for gitee/ehai that already sit in our ancestor chain
  const candidates = [
    ...remotes.map((r) => `refs/remotes/${r}/${branch}`),
    `refs/remotes/gitee/${branch}`,
    `refs/remotes/ehai/${branch}`,
  ];
  for (const ref of candidates) {
    try {
      const sha = execGit(['rev-parse', `${ref}^{commit}`]);
      const count = Number(execGit(['rev-list', '--count', sha]));
      if (count >= 2) return sha;
    } catch {
      /* try next */
    }
  }
  throw new Error(
    'ABORT: Could not resolve a multi-commit public parent baseline (expected >=2 prior public commits). Pass --parent <sha> explicitly so public history is never accidentally orphaned.'
  );
}

function main() {
  const { push, overwriteTag, forceRealign, parentRef, remotes, branch } = parseArgs(process.argv.slice(2));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const version = String(pkg.version || '').trim();
  if (!SEMVER_RE.test(version)) {
    console.error(`ABORT: Invalid package.json semver "${version}".`);
    process.exit(1);
  }
  if (!SAFE_REF_RE.test(branch)) {
    console.error(`ABORT: Unsafe target branch name "${branch}".`);
    process.exit(1);
  }
  const tagName = `v${version}`;

  let originUrlNorm = '';
  try {
    originUrlNorm = normalizeGitUrl(execGit(['remote', 'get-url', '--push', 'origin']));
  } catch { /* ignore if origin absent */ }

  for (const r of remotes) {
    const lower = r.toLowerCase();
    if (FORBIDDEN_REMOTES.has(lower) || !ALLOWED_CLEAN_RELEASE_REMOTES.has(lower)) {
      console.error(`ABORT: Remote "${r}" is not in ALLOWED_CLEAN_RELEASE_REMOTES (${[...ALLOWED_CLEAN_RELEASE_REMOTES].join(', ')}). Protected engineering remotes like origin may NEVER be squashed.`);
      process.exit(1);
    }
  }

  const currentBranch = execGit(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (currentBranch !== 'main') {
    console.error(`ABORT: Source repository must be on 'main' branch (currently on '${currentBranch}').`);
    process.exit(1);
  }

  // Verify clean tracked git status in source repo
  const dirtyTracked = execGit(['status', '--porcelain', '--untracked-files=no']);
  if (dirtyTracked) {
    console.error('ABORT: Tracked modifications exist in workspace. Commit to `origin/main` first so HEAD matches the release tree:\n' + dirtyTracked);
    process.exit(1);
  }

  const sourceHead = execGit(['rev-parse', '--short', 'HEAD']);
  const sourceHeadIsoDate = execGit(['show', '-s', '--format=%cI', 'HEAD']);
  const parentSha = resolvePublicParentSha(parentRef, remotes, branch);
  const parentShort = parentSha.slice(0, 7);
  const parentCommitCount = Number(execGit(['rev-list', '--count', parentSha]));
  if (parentCommitCount < 2) {
    console.error(`ABORT: Public parent ${parentShort} only has ${parentCommitCount} commit(s). Refusing to orphan public history!`);
    process.exit(1);
  }

  const remoteMap = {};
  for (const r of remotes) {
    try {
      const resolvedUrl = execGit(['remote', 'get-url', '--push', r]);
      const norm = normalizeGitUrl(resolvedUrl);
      if (originUrlNorm && norm === originUrlNorm) {
        console.error(`ABORT: Remote "${r}" resolves to protected origin URL "${resolvedUrl}". Refusing to overwrite full history.`);
        process.exit(1);
      }
      remoteMap[r] = resolvedUrl;
    } catch {
      console.error(`ABORT: Git remote "${r}" is not configured in this repository.`);
      process.exit(1);
    }
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `harmony-clean-release-${version}-`));
  try {
    console.log(`\n[clean-release] Staging incremental public release ${tagName} on top of public baseline ${parentShort} (${parentCommitCount} prior commits, source HEAD ${sourceHead})...`);
    const tarBuf = cp.execFileSync('git', ['archive', '--format=tar', 'HEAD'], {
      cwd: ROOT,
      maxBuffer: 256 * 1024 * 1024,
    });

    // Initialize isolated repo and fetch ONLY the cleaned public baseline ancestor chain (never intermediate dev commits)
    execGit(['init', '-b', '_staging'], tmpDir, true);
    execGit(['config', 'user.name', 'Harmony Release'], tmpDir, true);
    execGit(['config', 'user.email', 'noreply@harmony.local'], tmpDir, true);
    execGit(['fetch', '--no-tags', ROOT, `${parentSha}:refs/remotes/public/baseline`], tmpDir, true);
    execGit(['checkout', '-B', branch, 'refs/remotes/public/baseline'], tmpDir, true);

    // Replace working tree with exact tracked HEAD archive so commit diff is parent -> HEAD
    execGit(['rm', '-rf', '--quiet', '.'], tmpDir, true);
    cp.execFileSync('tar', ['-xf', '-', '-C', tmpDir], { input: tarBuf });

    const stagedPkgPath = path.join(tmpDir, 'package.json');
    if (!fs.existsSync(stagedPkgPath)) {
      throw new Error('Staged archive missing package.json — aborting.');
    }

    execGit(['add', '-A'], tmpDir, true);
    const stagedDelta = execGit(['status', '--porcelain'], tmpDir, true);
    if (!stagedDelta) {
      throw new Error(`Staged release tree is identical to public parent ${parentShort} — nothing new to release.`);
    }

    const releaseMsg = `Harmony Extension v${version}`;
    const detEnv = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_DATE: sourceHeadIsoDate,
      GIT_COMMITTER_DATE: sourceHeadIsoDate,
    };
    cp.execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', 'commit', '-m', releaseMsg], {
      cwd: tmpDir,
      encoding: 'utf8',
      env: detEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    cp.execFileSync('git', ['-c', 'tag.gpgsign=false', '-c', 'core.hooksPath=', 'tag', '-a', tagName, '-m', `Harmony Extension ${tagName}`], {
      cwd: tmpDir,
      encoding: 'utf8',
      env: detEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Run full push-grade privacy, path & history scanner across ALL (parentCommitCount + 1) commits!
    const checkRepoScript = path.join(tmpDir, 'scripts', 'check-repo.js');
    if (fs.existsSync(checkRepoScript)) {
      console.log(`[clean-release] Running scripts/check-repo.js --entry push across all ${parentCommitCount + 1} public commits...`);
      cp.execFileSync(process.execPath, [checkRepoScript, '--entry', 'push'], { cwd: tmpDir, stdio: 'inherit' });
    }

    const commitCount = Number(execGit(['rev-list', '--count', 'HEAD'], tmpDir, true));
    const cleanSha = execGit(['rev-parse', 'HEAD'], tmpDir, true);
    const actualParent = execGit(['rev-parse', 'HEAD^'], tmpDir, true);
    const trackedCount = execGit(['ls-files'], tmpDir, true).split(/\r?\n/).filter(Boolean).length;

    if (commitCount !== parentCommitCount + 1 || actualParent !== parentSha || trackedCount < 50) {
      throw new Error(
        `Sanity gate failed: commits=${commitCount} (expected ${parentCommitCount + 1}), parent=${actualParent} (expected ${parentSha}), trackedFiles=${trackedCount}`
      );
    }

    console.log('\n[clean-release] Verified Incremental Public Release Commit:');
    console.log(`  Version / Tag   : ${tagName}`);
    console.log(`  Source HEAD     : ${sourceHead} (full granular dev history preserved on origin)`);
    console.log(`  Public Parent   : ${parentSha} (${parentCommitCount} prior public commits preserved!)`);
    console.log(`  New Public HEAD : ${cleanSha} (commit count = ${commitCount})`);
    console.log(`  Tracked Files   : ${trackedCount}`);
    for (const [r, url] of Object.entries(remoteMap)) {
      console.log(`  Target Remote   : ${r} -> ${url} (${branch} + ${tagName})`);
    }

    if (!push) {
      console.log('\n[clean-release] DRY-RUN PASSED ✅ (nothing pushed).');
      console.log(`To publish this verified ${commitCount}-commit branch to ${remotes.join(', ')}, run:`);
      console.log(`  node scripts/publish-clean-release.js --parent ${parentShort} --remotes ${remotes.join(',')} --push\n`);
      return;
    }

    for (const [r, url] of Object.entries(remoteMap)) {
      console.log(`\n[clean-release] Checking existing tags on ${r} (${url})...`);
      const existingTag = execGit(['ls-remote', '--tags', url, `refs/tags/${tagName}`], tmpDir, true);
      if (existingTag && !overwriteTag) {
        throw new Error(`Tag ${tagName} already exists on ${r}. Pass --overwrite-tag only if intentionally replacing a pre-release tag.`);
      }
      console.log(`[clean-release] Pushing ${commitCount}-commit ${branch} + ${tagName} to ${r} (${url})...`);
      execGit(['remote', 'add', r, url], tmpDir, true);
      // Fast-forward push by default! Only allow --force when --force-realign is explicitly passed (e.g. recovering an orphaned remote).
      const branchPushArgs = forceRealign
        ? ['push', '--force', r, `${branch}:${branch}`]
        : ['push', r, `${branch}:${branch}`];
      cp.execFileSync('git', branchPushArgs, { cwd: tmpDir, stdio: 'inherit' });
      const tagPushArgs = overwriteTag
        ? ['push', '--force', r, `refs/tags/${tagName}:refs/tags/${tagName}`]
        : ['push', r, `refs/tags/${tagName}:refs/tags/${tagName}`];
      cp.execFileSync('git', tagPushArgs, { cwd: tmpDir, stdio: 'inherit' });
      // Update local remote-tracking ref so git show-ref reflects the new public tip
      try {
        execGit(['fetch', r, `${branch}:refs/remotes/${r}/${branch}`], ROOT, false);
      } catch { /* non-fatal */ }
    }
    console.log(`\n[clean-release] PUBLISHED ${tagName} cleanly (${commitCount} total commits, parent ${parentShort}) to: ${remotes.join(', ')} ✅\n`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main();

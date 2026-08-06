/**
 * exoskeleton/constants.ts — Governance constants for the Exoskeleton system.
 *
 * These are the starting values from the Pilot Exoskeleton v2.0 blueprint.
 * They are tunable with LEDGER data — change only when measurement justifies it.
 */

/** Maximum oracle attempts on the same failure signature before HALT. */
export const MAX_ORACLE_ATTEMPTS = 5;

/** Attempt number at which to print a replan nudge (non-blocking). */
export const NUDGE_AT = 3;

/** Maximum tokens a specialist dispatch may return (chars/4 estimator). */
export const MAX_TOOL_RETURN_TOKENS = 300;

/** Oracle timeout in milliseconds. Speed beats coverage. */
export const ORACLE_TIMEOUT_MS = 60_000;

/** Ideal oracle duration target in milliseconds. */
export const ORACLE_TARGET_MS = 15_000;

/** Specialist index token budget (chars/4 estimator). */
export const SPECIALIST_INDEX_BUDGET_TOKENS = 500;

/** Knowledge ratchet total token budget (chars/4 estimator). */
export const RATCHET_BUDGET_TOKENS = 8_000;

/** Spine template version. */
export const SPINE_VERSION = '2.0';

/** Spine state file path (relative to workspace root). */
export const SPINE_JSON_PATH = '.harmony/spine.json';

/** Spine human-readable mirror path (relative to workspace root). */
export const SPINE_MD_PATH = '.harmony/spine.md';

/** Oracle attempts persistence path. */
export const ORACLE_STATE_PATH = '.harmony/oracle-state.json';

/** Dispatch full reports directory. */
export const DISPATCH_DIR = '.harmony/dispatches';

/**
 * Protected paths — edits to these require explicit operator approval.
 * Normalized to POSIX-style forward slashes for comparison.
 */
export const PROTECTED_PATHS: readonly string[] = [
    '.harmony/hooks/',
    '.harmony/oracle/',
    '.harmony/spine.json',
    '.harmony/routes.json',
    '.harmony/contracts.json',
    '.harmony/gitleaksignore',
    '.harmony/checksums.sha256',
];

/**
 * Secret patterns for pre-commit scanning and BLOCKED redaction.
 * Simple regex patterns — not a replacement for gitleaks, but a first line.
 */
export const SECRET_PATTERNS: readonly RegExp[] = [
    /(?:sk-)[a-zA-Z0-9]{20,}/g,           // OpenAI-style keys
    /(?:sk-kimi-)[a-zA-Z0-9]{20,}/g,       // KimiCode keys
    /(?:ghp_)[a-zA-Z0-9]{36,}/g,           // GitHub PATs
    /(?:gho_)[a-zA-Z0-9]{36,}/g,           // GitHub OAuth
    /(?:AKIA)[A-Z0-9]{16}/g,               // AWS access keys
    /(?:xoxb-)[a-zA-Z0-9-]+/g,             // Slack bots
    /(?:AIza)[a-zA-Z0-9_-]{35}/g,          // Google API keys
];

/** Exoskeleton version — follows the blueprint version it implements. */
export const EXOSKELETON_VERSION = '2.0.0-mvp';

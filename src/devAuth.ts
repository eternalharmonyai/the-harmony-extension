/**
 * Developer authorisation for the Harmony Dev surface.
 *
 * Design constraints (decided deliberately, do not relax them casually):
 *  - AUTHORISATION, NOT A TOGGLE. A gate must live one privilege level above what
 *    it gates. A UI toggle inside the section it reveals moves with that section.
 *  - The token lives OUTSIDE the repo and OUTSIDE the VSIX, so it cannot be
 *    committed, packaged, or synced.
 *  - The RESOLVED path is never returned, rendered, logged, or put in an error
 *    message. A resolved %LOCALAPPDATA% path contains the user's account name.
 *    Callers get a boolean or an UNEXPANDED display string built from env vars only.
 *  - Fail closed. A missing, empty, unreadable, or malformed token means "no".
 *  - No claim of secrecy. The compiled bundle is readable. This raises the effort
 *    of reaching the surface accidentally; it is not cryptography and must never
 *    be described as such.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Cookie that carries a minted developer session id. */
export const DEV_COOKIE_NAME = 'harmony_dev';

/** How long a minted developer session stays valid. */
export const DEV_SESSION_TTL_MS = 30 * 60 * 1000;

const TOKEN_BYTES = 32;
const TOKEN_FILENAME = 'dev-token';
const APP_DIRNAME = 'Harmony';

/** Sanitise a path for an error message: basename only, never the full location. */
function safeLabel(filePath: string): string {
    try {
        return path.basename(filePath);
    } catch {
        return TOKEN_FILENAME;
    }
}

/** Resolve the token path. Never hand the result to a renderer or a log line. */
function resolveDevTokenPath(): string {
    if (process.platform === 'win32') {
        const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
        return path.join(base, APP_DIRNAME, TOKEN_FILENAME);
    }
    const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    return path.join(base, 'harmony', TOKEN_FILENAME);
}

/**
 * The only form of the token location that may be shown to a human.
 * Built from environment variable names, so it never reveals an account name.
 */
export function getDevTokenDisplayPath(): string {
    if (process.platform === 'win32') {
        return `%LOCALAPPDATA%\\${APP_DIRNAME}\\${TOKEN_FILENAME}`;
    }
    return `$XDG_CONFIG_HOME/harmony/${TOKEN_FILENAME}`;
}

/** Constant-time comparison that tolerates unequal lengths without throwing. */
export function safeTokenEquals(a: string, b: string): boolean {
    const left = Buffer.from(String(a ?? ''), 'utf8');
    const right = Buffer.from(String(b ?? ''), 'utf8');
    // Compare a fixed-length digest of each side so length itself is not a signal.
    const leftDigest = crypto.createHash('sha256').update(left).digest();
    const rightDigest = crypto.createHash('sha256').update(right).digest();
    const equal = crypto.timingSafeEqual(leftDigest, rightDigest);
    // Digests matching is not enough: an empty candidate hashes to a known value.
    return equal && left.length > 0 && right.length === left.length;
}

/** Read the developer token, or null when it is absent or unusable. Never throws. */
export function readDevToken(): string | null {
    const filePath = resolveDevTokenPath();
    try {
        if (!fs.existsSync(filePath)) return null;
        const raw = fs.readFileSync(filePath, 'utf8').trim();
        if (!raw || !/^[a-f0-9]{16,}$/i.test(raw)) return null;
        return raw;
    } catch {
        return null;
    }
}

/** True when a usable token exists. A boolean only — the path never leaves this module. */
export function isDevTokenPresent(): boolean {
    return readDevToken() !== null;
}

/**
 * Create the developer token if it does not exist yet.
 *
 * Returns whether it was created and the UNEXPANDED display path. If the file
 * already exists and is usable, it is left untouched — rotating a live token
 * would silently revoke an authorisation the developer deliberately set up.
 */
export function ensureDevToken(): { created: boolean; displayPath: string; present: boolean } {
    const displayPath = getDevTokenDisplayPath();
    const existing = readDevToken();
    if (existing) {
        return { created: false, displayPath, present: true };
    }

    const filePath = resolveDevTokenPath();
    const label = safeLabel(filePath);
    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
        fs.writeFileSync(filePath, token, { encoding: 'utf8', mode: 0o600 });
        // mode is honoured on POSIX; on Windows a best-effort chmod is the ceiling here.
        try { fs.chmodSync(filePath, 0o600); } catch { /* best effort only */ }
        return { created: true, displayPath, present: true };
    } catch (err: any) {
        // Message must not contain the resolved path.
        throw new Error(`Could not create the developer token file (${label}).`);
    }
}

/** Verify a candidate token against the stored one. Fail closed. */
export function verifyDevToken(candidate: string): boolean {
    const stored = readDevToken();
    if (!stored) return false;
    return safeTokenEquals(candidate, stored);
}

type DevSession = { id: string; expiresAt: number };

const sessions = new Map<string, DevSession>();

function pruneExpired(now: number): void {
    for (const [id, session] of Array.from(sessions.entries())) {
        if (session.expiresAt <= now) sessions.delete(id);
    }
}

/**
 * Mint a short-lived developer session after a successful token check.
 * Sessions are process-local on purpose: if the host restarts, every session
 * dies and authorisation must be granted again. Fail closed, never open.
 */
export function mintDevSession(): { id: string; expiresAt: number } {
    const now = Date.now();
    pruneExpired(now);
    const id = crypto.randomBytes(24).toString('hex');
    const expiresAt = now + DEV_SESSION_TTL_MS;
    sessions.set(id, { id, expiresAt });
    return { id, expiresAt };
}

/** True when the session id is live. */
export function verifyDevSession(sessionId: string | undefined | null): boolean {
    if (!sessionId) return false;
    const now = Date.now();
    pruneExpired(now);
    const session = sessions.get(String(sessionId));
    if (!session) return false;
    if (session.expiresAt <= now) {
        sessions.delete(session.id);
        return false;
    }
    return true;
}

/** Drop a session immediately (used when the token is rotated or removed). */
export function revokeDevSession(sessionId: string | undefined | null): void {
    if (!sessionId) return;
    sessions.delete(String(sessionId));
}

/** Parse the dev cookie out of a raw Cookie header. */
export function readDevCookie(cookieHeader: string | undefined): string | null {
    if (!cookieHeader) return null;
    const parts = String(cookieHeader).split(';');
    for (const part of parts) {
        const index = part.indexOf('=');
        if (index === -1) continue;
        const name = part.slice(0, index).trim();
        if (name !== DEV_COOKIE_NAME) continue;
        const value = part.slice(index + 1).trim();
        if (!value) return null;
        try {
            return decodeURIComponent(value);
        } catch {
            return value;
        }
    }
    return null;
}

/** Build the Set-Cookie header for a minted session. */
export function buildDevSessionCookie(sessionId: string | null): string {
    if (!sessionId) {
        // Expire the cookie.
        return `${DEV_COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/dev; Max-Age=0`;
    }
    const maxAge = Math.floor(DEV_SESSION_TTL_MS / 1000);
    return `${DEV_COOKIE_NAME}=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Strict; Path=/dev; Max-Age=${maxAge}`;
}

/** Is this request carrying a live developer session? */
export function isDevRequestAuthorized(req: { headers: Record<string, any> }): boolean {
    const cookie = readDevCookie(String(req?.headers?.cookie || ''));
    return verifyDevSession(cookie);
}

/** Test-only: drop every session so a gate can prove fail-closed behaviour. */
export function resetDevSessionsForTests(): void {
    sessions.clear();
}

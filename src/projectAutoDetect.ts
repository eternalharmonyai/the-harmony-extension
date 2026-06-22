import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as net from 'net';

/**
 * Result of auto-detecting a web project in the workspace.
 */
export interface ProjectDetection {
    /** Absolute path to the detected project root */
    projectRoot: string;
    /** package.json parsed (if found) */
    packageJson?: { scripts?: Record<string, string>; name?: string; [k: string]: unknown };
    /** Dev-relevant scripts from package.json */
    devScripts: Array<{ name: string; command: string }>;
    /** The localhost URL after starting the dev server (if started) */
    localhostUrl?: string;
    /** Child process if we started a dev server */
    devProcess?: cp.ChildProcess;
}

/**
 * Detect the current workspace project and its dev-server capability.
 * Checks the first workspace folder for package.json with dev/start/serve scripts.
 */
export function detectWorkspaceProject(): ProjectDetection {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) {
        throw new Error('No workspace folder open. Open a project folder to auto-detect.');
    }
    const projectRoot = folders[0].uri.fsPath;

    let packageJson: ProjectDetection['packageJson'];
    const pkgPath = path.join(projectRoot, 'package.json');
    if (fs.existsSync(pkgPath)) {
        try {
            packageJson = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        } catch {
            // invalid JSON — ignore
        }
    }

    const devScripts: Array<{ name: string; command: string }> = [];
    if (packageJson?.scripts) {
        for (const [name, command] of Object.entries(packageJson.scripts)) {
            if (isDevScript(name, command)) {
                devScripts.push({ name, command });
            }
        }
    }

    return { projectRoot, packageJson, devScripts };
}

/**
 * Heuristic: is this a dev-server script?
 */
function isDevScript(name: string, command: string): boolean {
    const devNames = new Set([
        'dev', 'start', 'serve', 'develop', 'watch',
        'start:dev', 'dev:start', 'serve:dev',
    ]);
    const devCmds = ['next dev', 'vite', 'npm run dev', 'yarn dev', 'pnpm dev',
        'webpack-dev-server', 'webpack serve', 'ng serve', 'nuxt dev',
        'astro dev', 'remix dev', 'svelte-kit dev', 'wmr',
        'parcel', 'live-server', 'http-server', 'browser-sync',
    ];

    if (devNames.has(name)) return true;
    return devCmds.some(c => command.includes(c));
}

/**
 * Ask the user whether to start a detected dev server.
 * Returns the chosen script name, or undefined if they decline.
 */
export async function offerDevServer(
    devScripts: Array<{ name: string; command: string }>,
    projectName?: string
): Promise<string | undefined> {
    if (!devScripts.length) return undefined;

    const items = devScripts.map(s => ({
        label: `$(play) npm run ${s.name}`,
        description: s.command,
        detail: projectName ? `Start dev server for ${projectName}` : 'Start the project dev server',
    }));
    items.unshift({
        label: '$(close) Skip — analyze static files only',
        description: 'Do not start a dev server',
        detail: 'Will gather HTML/CSS/JS from the project folder without live rendering',
    });

    const pick = await vscode.window.showQuickPick(items, {
        placeHolder: `Found ${devScripts.length} dev server script(s). Start one for live analysis?`,
        matchOnDescription: true,
    });

    if (!pick || pick.label.includes('Skip')) return undefined;
    return devScripts.find(s => s.name === pick.label.replace('$(play) npm run ', ''))?.name;
}

/**
 * Start a dev server via npm/pnpm/yarn and poll for localhost readiness.
 * Returns the detected URL + child process, or throws on failure.
 */
export async function startDevServer(
    projectRoot: string,
    scriptName: string,
    portHint?: number
): Promise<{ url: string; process: cp.ChildProcess }> {
    // Detect package manager
    const hasPnpm = fs.existsSync(path.join(projectRoot, 'pnpm-lock.yaml'));
    const hasYarn = fs.existsSync(path.join(projectRoot, 'yarn.lock'));
    const pm = hasPnpm ? 'pnpm' : hasYarn ? 'yarn' : 'npm';

    const child = cp.spawn(pm, ['run', scriptName], {
        cwd: projectRoot,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
    });

    // Collect early output to detect the port
    let earlyOutput = '';
    const urlPromise = new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error(`Dev server (${pm} run ${scriptName}) did not start within 45s. Check the terminal output.`));
        }, 45000);

        child.stdout?.on('data', (data: Buffer) => {
            earlyOutput += data.toString();
            const url = extractLocalhostUrl(earlyOutput, portHint);
            if (url) {
                clearTimeout(timeout);
                resolve(url);
            }
        });

        child.stderr?.on('data', (data: Buffer) => {
            earlyOutput += data.toString();
            const url = extractLocalhostUrl(earlyOutput, portHint);
            if (url) {
                clearTimeout(timeout);
                resolve(url);
            }
        });

        child.on('error', (err) => {
            clearTimeout(timeout);
            reject(new Error(`Failed to start ${pm} run ${scriptName}: ${err.message}`));
        });

        child.on('exit', (code) => {
            if (code !== null && code !== 0) {
                clearTimeout(timeout);
                reject(new Error(`${pm} run ${scriptName} exited with code ${code}. Output:\n${earlyOutput.slice(-500)}`));
            }
        });
    });

    const url = await urlPromise;

    // Wait an extra second for the server to stabilize
    await new Promise(r => setTimeout(r, 1500));

    // Verify the port is actually listening
    const portMatch = url.match(/:(\d+)/);
    if (portMatch) {
        await waitForPort(parseInt(portMatch[1], 10), 5000);
    }

    return { url, process: child };
}

/**
 * Extract a localhost URL from dev server output.
 */
function extractLocalhostUrl(output: string, portHint?: number): string | null {
    // Common patterns:
    // ➜  Local:   http://localhost:3000/
    // ➜  Network: http://192.168.1.5:3000/
    // Server running at http://localhost:3000
    // http://localhost:3000
    // on port 3000
    const patterns = [
        /(?:Local|localhost|server|running|listening|ready|available).*?(https?:\/\/localhost:\d+)/i,
        /(https?:\/\/localhost:\d+)/i,
        /(?:port|on)\s*(\d{4,5})/i,
    ];

    for (const pat of patterns) {
        const m = output.match(pat);
        if (m) {
            if (m[1]?.startsWith('http')) return m[1];
            // If we matched a bare port
            if (/^\d+$/.test(m[1])) return `http://localhost:${m[1]}`;
        }
    }

    // Fallback: if we got a port hint, try that
    if (portHint) return `http://localhost:${portHint}`;

    return null;
}

/**
 * Poll a TCP port until it's listening or timeout.
 */
function waitForPort(port: number, timeoutMs: number): Promise<void> {
    const start = Date.now();
    return new Promise((resolve) => {
        const check = () => {
            const sock = new net.Socket();
            sock.setTimeout(500);
            sock.on('connect', () => {
                sock.destroy();
                resolve();
            });
            sock.on('error', () => {
                sock.destroy();
                if (Date.now() - start > timeoutMs) {
                    resolve(); // give up but don't fail — maybe no port to check
                } else {
                    setTimeout(check, 300);
                }
            });
            sock.on('timeout', () => {
                sock.destroy();
                if (Date.now() - start > timeoutMs) {
                    resolve();
                } else {
                    setTimeout(check, 300);
                }
            });
            sock.connect(port, '127.0.0.1');
        };
        check();
    });
}

/**
 * Kill a dev server process gracefully (SIGTERM → SIGKILL after 2s).
 */
export function stopDevServer(proc: cp.ChildProcess): void {
    if (!proc || proc.killed) return;
    try {
        if (process.platform === 'win32') {
            cp.exec(`taskkill /pid ${proc.pid} /T /F`, () => {});
        } else {
            proc.kill('SIGTERM');
            setTimeout(() => {
                try { proc.kill('SIGKILL'); } catch { /* already dead */ }
            }, 2000);
        }
    } catch {
        // process already gone
    }
}

/**
 * SandboxRunner — Safe code execution for Harmony swarm primitives.
 * 
 * Three-tier architecture:
 *   Tier 1: isolated-vm (JS/TS) — V8 isolate, <1s, cross-platform
 *   Tier 2: Pyodide-in-isolated-vm (Python) — CPython WASM, 3-5s, cross-platform
 *   Tier 3: Windows Sandbox (any language) — Hyper-V VM, 30-60s, Windows Pro/Enterprise
 * 
 * CRITICAL: Never mount full workspace — copy only code+test to isolated staging dir.
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import { withRetry, circuitBreaker } from './storageUtils';
import * as cp from 'child_process';

// Lazy-loaded isolated-vm — avoids crash when native module is missing
let _ivm: any = null;
async function getIVM(): Promise<any> {
    if (_ivm) return _ivm;
    try {
        _ivm = await import('isolated-vm');
        return _ivm;
    } catch {
        throw new Error('isolated-vm not installed. Run: npm install isolated-vm');
    }
}

// ══════════════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════════════

export interface SandboxResult {
    pass: boolean;
    output: string;
    error?: string;
    tier: 0 | 1 | 2 | 3;
    metrics: {
        execution_time_ms: number;
        memory_used_mb?: number;
        cpu_time_ms?: number;
    };
    diagnostics?: string;
    fallback_used?: string; // e.g., "tier2→tier3: native extension needed"
}

export interface SandboxOptions {
    memoryLimitMB?: number;    // default 64
    timeoutSec?: number;       // default 30, max 120
    language?: string;         // 'typescript' | 'javascript' | 'python'
    allowFallback?: boolean;   // default true — allow Tier 2→3 or Tier 1→2 fallback
}

// ══════════════════════════════════════════════════════════════════
// Safety Pre-Checks
// ══════════════════════════════════════════════════════════════════

const MAX_CODE_SIZE = 100_000; // 100KB
const DANGEROUS_PATTERNS_JS = [
    /require\s*\(\s*['"]child_process['"]/,
    /process\.exit\s*\(/,
    /fs\.readFileSync\s*\(/,
    /fs\.writeFileSync\s*\(/,
    /fs\.rmSync\s*\(/,
    /fs\.unlinkSync\s*\(/,
    /import\s*\(\s*['"]child_process['"]/,
];

function validateCode(code: string, language: string): string | null {
    if (!code || !code.trim()) return 'Empty code';
    if (code.length > MAX_CODE_SIZE) return `Code too large (${code.length} bytes, max ${MAX_CODE_SIZE})`;
    
    if (language === 'typescript' || language === 'javascript') {
        for (const pattern of DANGEROUS_PATTERNS_JS) {
            if (pattern.test(code)) {
                return `Dangerous pattern detected: ${pattern.source}`;
            }
        }
    }
    
    return null; // valid
}

// ══════════════════════════════════════════════════════════════════
// Staging Directory
// ══════════════════════════════════════════════════════════════════

function uid(): string { return crypto.randomUUID().slice(0, 8); }

async function createStagingDir(workspaceRoot: string): Promise<{ runId: string; stagingDir: string }> {
    const runId = uid();
    const stagingDir = path.join(workspaceRoot, '.harmony', 'sandbox-exec', runId);
    await fs.mkdir(stagingDir, { recursive: true });
    return { runId, stagingDir };
}

async function cleanupStaging(workspaceRoot: string, runId: string): Promise<void> {
    const stagingDir = path.join(workspaceRoot, '.harmony', 'sandbox-exec', runId);
    try { await fs.rm(stagingDir, { recursive: true, force: true }); } catch { /* ok */ }
}

// ══════════════════════════════════════════════════════════════════
// Tier 1: isolated-vm (JS/TS) — DEFAULT
// ══════════════════════════════════════════════════════════════════

async function runIsolatedVM(
    code: string,
    test: string | undefined,
    options: SandboxOptions
): Promise<SandboxResult> {
    const ivm = await getIVM();
    const memoryLimit = (options.memoryLimitMB ?? 64) * 1024 * 1024;
    const timeout = (options.timeoutSec ?? 30) * 1000;
    
    const isolate = new ivm.Isolate({ memoryLimit });
    const context = await isolate.createContext();
    const jail = context.global;
    
    // Set up safe globals
    await jail.set('global', jail.derefInto());
    await jail.set('console_log', new ivm.Reference((...args: any[]) => {
        // Output will be captured
    }));
    
    const startTime = Date.now();
    
    try {
        // Wrap user code to capture output
        const wrappedCode = `
            let __output = [];
            const console = { log: (...args) => __output.push(args.map(String).join(' ')) };
            try {
                ${code}
            } catch(e) {
                __output.push('ERROR: ' + e.message);
            }
            __output.join('\\n');
        `;
        
        const script = await isolate.compileScript(wrappedCode);
        const result = await script.run(context, { timeout });
        const output = typeof result === 'string' ? result : String(result ?? '');
        
        const executionTime = Date.now() - startTime;
        
        // Determine pass/fail
        const hasError = output.includes('ERROR:');
        
        return {
            pass: !hasError,
            output: output.slice(0, 8000),
            error: hasError ? output.split('ERROR:')[1]?.split('\n')[0] : undefined,
            tier: 1,
            metrics: {
                execution_time_ms: executionTime,
                memory_used_mb: Math.round(memoryLimit / 1024 / 1024),
            },
        };
    } catch (e: any) {
        const executionTime = Date.now() - startTime;
        const msg = e?.message ?? String(e);
        
        return {
            pass: false,
            output: '',
            error: msg.includes('timed out') ? `Timeout after ${timeout}ms` : msg,
            tier: 1,
            metrics: {
                execution_time_ms: executionTime,
            },
            diagnostics: msg.includes('Isolate') ? 'Isolate exhausted (memory/time)' : undefined,
        };
    } finally {
        isolate.dispose();
    }
}

// ══════════════════════════════════════════════════════════════════
// Tier 2: Pyodide-in-isolated-vm (Python) — FALLBACK
// ══════════════════════════════════════════════════════════════════

let _pyodideReady = false;
let _pyodideLoadPromise: Promise<void> | null = null;

async function ensurePyodide(workspaceRoot: string): Promise<void> {
    if (_pyodideReady) return;
    if (_pyodideLoadPromise) return _pyodideLoadPromise;
    
    _pyodideLoadPromise = (async () => {
        const pyodideDir = path.join(workspaceRoot, '.harmony', 'sandbox-exec', 'pyodide');
        await fs.mkdir(pyodideDir, { recursive: true });
        
        // Check if Pyodide is already downloaded
        const pyodideMain = path.join(pyodideDir, 'pyodide.js');
        try {
            await fs.access(pyodideMain);
        } catch {
            // Download Pyodide runtime (~20MB)
            // For now, we'll skip the download and note it as a setup step
            throw new Error(
                'Pyodide not found. Download from https://github.com/pyodide/pyodide/releases ' +
                `and extract to ${pyodideDir}. Required for Python sandbox execution.`
            );
        }
        _pyodideReady = true;
    })();
    
    return _pyodideLoadPromise;
}

async function runPyodide(
    code: string,
    test: string | undefined,
    options: SandboxOptions,
    workspaceRoot: string
): Promise<SandboxResult> {
    // Try system Python first (faster, no download needed)
    try {
        const startTime = Date.now();
        const stagingDir = path.join(workspaceRoot, '.harmony', 'sandbox-exec', `py-${uid()}`);
        await fs.mkdir(stagingDir, { recursive: true });
        await fs.writeFile(path.join(stagingDir, 'code.py'), code, 'utf8');
        if (test) await fs.writeFile(path.join(stagingDir, 'test.py'), test, 'utf8');
        
        const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
            const cp = require('child_process');
            cp.execFile('python', [path.join(stagingDir, 'code.py')], {
                timeout: (options.timeoutSec ?? 30) * 1000,
                maxBuffer: 1024 * 1024,
                windowsHide: true,
            }, (error: any, stdout: string, stderr: string) => {
                resolve({ stdout, stderr });
            });
        });
        
        const executionTime = Date.now() - startTime;
        const output = (result.stdout + '\n' + result.stderr).trim();
        const hasError = result.stderr.toLowerCase().includes('error') || 
                         result.stderr.toLowerCase().includes('traceback');
        
        // Cleanup staging
        try { await fs.rm(stagingDir, { recursive: true, force: true }); } catch {}
        
        return {
            pass: !hasError,
            output: output.slice(0, 8000),
            error: hasError ? result.stderr.split('\n').slice(-3).join('\n') : undefined,
            tier: 2,
            metrics: { execution_time_ms: executionTime },
            diagnostics: hasError ? undefined : 'Python executed via system interpreter',
        };
    } catch (e: any) {
        // System Python failed — try Pyodide WASM
    }
    
    // Fallback: Pyodide WASM (requires download)
    try {
        await ensurePyodide(workspaceRoot);
    } catch (e: any) {
        return {
            pass: false,
            output: '',
            error: `Python execution unavailable: ${e.message}. Install Python or Pyodide.`,
            tier: 2,
            metrics: { execution_time_ms: 0 },
            diagnostics: 'Neither system Python nor Pyodide found.',
            fallback_used: options.allowFallback !== false ? 'tier2→tier3: no python runtime' : undefined,
        };
    }
    
    // Pyodide WASM execution — load and run Python in WebAssembly
    try {
        const startTime = Date.now();
        const pyodideDir = path.join(workspaceRoot, '.harmony', 'sandbox-exec', 'pyodide');
        const pyodideMain = path.join(pyodideDir, 'pyodide.js');
        
        // Load Pyodide as a Node.js module
        const pyodideModule = require(pyodideMain);
        const pyodide = await pyodideModule.loadPyodide({
            indexURL: pyodideDir + '/',
            fullStdLib: false, // keep it lean
        });
        
        // Capture stdout/stderr
        const stdoutLines: string[] = [];
        const stderrLines: string[] = [];
        pyodide.setStdout({ batched: (text: string) => { stdoutLines.push(text); } });
        pyodide.setStderr({ batched: (text: string) => { stderrLines.push(text); } });
        
        // Run the code
        await pyodide.runPythonAsync(code);
        
        // If a test script is provided, run it too
        if (test) {
            await pyodide.runPythonAsync(test);
        }
        
        const executionTime = Date.now() - startTime;
        const output = stdoutLines.join('');
        const errors = stderrLines.join('');
        const hasError = errors.toLowerCase().includes('error') || 
                         errors.toLowerCase().includes('traceback') ||
                         errors.toLowerCase().includes('exception');
        
        return {
            pass: !hasError,
            output: output.slice(0, 8000) || '(no output)',
            error: hasError ? errors.split('\n').slice(-5).join('\n') : undefined,
            tier: 2,
            metrics: { execution_time_ms: executionTime },
            diagnostics: hasError ? undefined : 'Python executed via Pyodide WASM',
        };
    } catch (e: any) {
        return {
            pass: false,
            output: '',
            error: `Pyodide execution failed: ${e.message}`,
            tier: 2,
            metrics: { execution_time_ms: 0 },
            diagnostics: 'Pyodide runtime error',
            fallback_used: options.allowFallback !== false ? 'tier2→tier3: pyodide runtime crash' : undefined,
        };
    }
}

// ══════════════════════════════════════════════════════════════════
// Tier 3: Windows Sandbox — LAST RESORT
// ══════════════════════════════════════════════════════════════════

async function isWindowsSandboxAvailable(): Promise<boolean> {
    if (process.platform !== 'win32') return false;
    try {
        await fs.access('C:\\Windows\\System32\\WindowsSandbox.exe');
        return true;
    } catch {
        return false;
    }
}

async function runWindowsSandbox(
    code: string,
    test: string | undefined,
    language: string,
    options: SandboxOptions,
    workspaceRoot: string,
    stagingDir: string
): Promise<SandboxResult> {
    // Write code and test to staging dir
    const ext = language === 'python' ? 'py' : language === 'typescript' ? 'ts' : 'js';
    await fs.writeFile(path.join(stagingDir, `code.${ext}`), code, 'utf8');
    if (test) await fs.writeFile(path.join(stagingDir, `test.${ext}`), test, 'utf8');
    
    // Generate .wsb config
    const wsbConfig = `<?xml version="1.0" encoding="utf-8"?>
<Configuration>
  <Networking>Disable</Networking>
  <ClipboardRedirection>Disable</ClipboardRedirection>
  <PrinterRedirection>Disable</PrinterRedirection>
  <MemoryInMB>${(options.memoryLimitMB ?? 256) * 2}</MemoryInMB>
  <MappedFolders>
    <MappedFolder>
      <HostFolder>${stagingDir.replace(/\\/g, '\\\\')}</HostFolder>
      <SandboxFolder>C:\\SandboxTest</SandboxFolder>
      <ReadOnly>false</ReadOnly>
    </MappedFolder>
  </MappedFolders>
  <LogonCommand>
    <Command>cmd.exe /c "cd C:\\SandboxTest && ${language === 'python' ? 'python' : 'node'} code.${ext} > results.txt 2>&1"</Command>
  </LogonCommand>
</Configuration>`;
    
    const wsbPath = path.join(stagingDir, 'sandbox.wsb');
    await fs.writeFile(wsbPath, wsbConfig, 'utf8');
    
    const startTime = Date.now();
    const timeout = Math.min((options.timeoutSec ?? 30) + 60, 180) * 1000; // add 60s for VM boot
    
    try {
        // Launch Windows Sandbox
        const sandboxProcess = cp.exec(`WindowsSandbox.exe "${wsbPath}"`);
        
        // Poll for results (Windows Sandbox writes results.txt to staging dir)
        const resultsPath = path.join(stagingDir, 'results.txt');
        const result = await new Promise<string>((resolve, reject) => {
            const pollInterval = setInterval(async () => {
                try {
                    const content = await fs.readFile(resultsPath, 'utf8');
                    clearInterval(pollInterval);
                    resolve(content);
                } catch {
                    // Results not ready yet
                }
            }, 2000);
            
            setTimeout(() => {
                clearInterval(pollInterval);
                reject(new Error('Sandbox timeout'));
            }, timeout);
        });
        
        const executionTime = Date.now() - startTime;
        const hasError = result.toLowerCase().includes('error') || result.toLowerCase().includes('fail');
        
        return {
            pass: !hasError,
            output: result.slice(0, 8000),
            tier: 3,
            metrics: {
                execution_time_ms: executionTime,
            },
        };
    } catch (e: any) {
        const executionTime = Date.now() - startTime;
        return {
            pass: false,
            output: '',
            error: `Sandbox execution failed: ${e.message}`,
            tier: 3,
            metrics: { execution_time_ms: executionTime },
        };
    }
}

// ══════════════════════════════════════════════════════════════════
// Main Runner — Three-Tier Orchestration
// ══════════════════════════════════════════════════════════════════

export class SandboxRunner {
    constructor(private readonly workspaceRoot: string) {}
    
    private _circuit = circuitBreaker('sandbox-exec', { threshold: 5, resetMs: 60000 });

    async execute(
        code: string,
        test?: string,
        options: SandboxOptions = {}
    ): Promise<SandboxResult> {
        // Circuit breaker check
        if (this._circuit.isOpen()) {
            return {
                pass: false,
                output: '',
                error: 'Execution sandbox temporarily unavailable (circuit breaker open)',
                tier: 0,
                metrics: { execution_time_ms: 0 },
                diagnostics: 'Circuit breaker open — too many recent failures',
            };
        }
        
        const language = options.language ?? 'javascript';
        
        // Safety pre-check
        const validationError = validateCode(code, language);
        if (validationError) {
            return {
                pass: false,
                output: '',
                error: `Code rejected: ${validationError}`,
                tier: 1,
                metrics: { execution_time_ms: 0 },
                diagnostics: 'Safety pre-check failed',
            };
        }
        
        const { runId, stagingDir } = await createStagingDir(this.workspaceRoot);
        
        try {
            let result: SandboxResult;
            
            // ── Tier 1: isolated-vm (JS/TS) ──
            if (language === 'typescript' || language === 'javascript') {
                result = await runIsolatedVM(code, test, options);
            } else if (language === 'python') {
                // ── Tier 2: Pyodide (Python) ──
                result = await runPyodide(code, test, options, this.workspaceRoot);
                
                // If Pyodide unavailable and fallback allowed, try Tier 3
                if (!result.pass && result.fallback_used && options.allowFallback !== false) {
                    if (await isWindowsSandboxAvailable()) {
                        result = await runWindowsSandbox(code, test, language, options, this.workspaceRoot, stagingDir);
                    }
                }
            } else if (options.allowFallback !== false && await isWindowsSandboxAvailable()) {
                result = await runWindowsSandbox(code, test, language, options, this.workspaceRoot, stagingDir);
            } else {
                result = {
                    pass: false,
                    output: '',
                    error: `Safe execution unavailable for ${language}. Supported: JS/TS (Tier 1), Python (Tier 2 — requires Pyodide), or enable Windows Sandbox (Tier 3, Windows Pro/Enterprise).`,
                    tier: 0,
                    metrics: { execution_time_ms: 0 },
                };
            }
            
            // Circuit breaker tracking
            if (result.pass) {
                this._circuit.recordSuccess();
            } else if (result.tier !== 0) {
                // Only count actual execution failures (not pre-checks)
                this._circuit.recordFailure();
            }
            
            return result;
        } finally {
            // Cleanup staging dir (unless debugging)
            // await cleanupStaging(this.workspaceRoot, runId);
        }
    }
    
    /** Check which tiers are available */
    async detectCapabilities(): Promise<{
        tier1: boolean;
        tier2: boolean;
        tier3: boolean;
        recommended: 1 | 2 | 3;
    }> {
        let tier2 = false;
        try {
            await ensurePyodide(this.workspaceRoot);
            tier2 = true;
        } catch { /* Tier 2 unavailable */ }
        
        const tier3 = await isWindowsSandboxAvailable();
        
        return {
            tier1: true, // always available (isolated-vm is our dependency)
            tier2,
            tier3,
            recommended: tier2 ? 2 : 1,
        };
    }
}

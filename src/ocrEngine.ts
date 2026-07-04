/**
 * Harmony OCR Engine — Cross-platform Optical Character Recognition.
 *
 * Strategy: Native-first, Tesseract.js fallback.
 *
 *   Windows  → Windows.Media.OCR (via winrt Python) → fastest, built-in
 *   macOS    → Apple Vision (via pyobjc Python)     → fast, built-in
 *   Linux    → Tesseract.js (WASM)                   → universal fallback
 *   Any      → Tesseract.js fallback                 → if native fails
 *
 * All OCR operations are fully async — never blocks the VS Code event loop.
 *
 * @module ocrEngine
 */

import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as vscode from 'vscode';

// ── Types ──────────────────────────────────────────────────────────────────

/** Supported OCR languages. 'eng' is always available via Tesseract.js. */
export type OcrLanguage = 'eng' | 'chi_sim' | 'chi_tra' | 'jpn' | 'kor' | 'fra' | 'deu' | 'spa';

export interface OcrResult {
    /** Extracted text, or empty string if nothing found */
    text: string;
    /** Confidence level */
    confidence: 'high' | 'medium' | 'low' | 'none';
    /** Which engine produced the result */
    engine: 'windows-ocr' | 'macos-vision' | 'tesseract.js' | 'none';
    /** Number of text lines detected */
    lineCount: number;
    /** Number of words detected */
    wordCount: number;
    /** Language code used */
    language: string;
    /** Human-readable hint for debugging */
    hint?: string;
    /** Raw engine-specific confidence score (0-100), if available */
    rawConfidence?: number;
}

export interface OcrOptions {
    /** Language for OCR. Default 'eng'. Native engines auto-detect OS language. */
    language?: OcrLanguage;
}

interface NativeOcrJson {
    ok: boolean;
    text: string;
    confidence: string;
    line_count: number;
    word_count: number;
    language: string;
    engine: string;
    hint?: string;
    error?: string;
    raw_confidence?: number;
}

// ── Confidence normalization ───────────────────────────────────────────────

function normalizeConfidence(raw: string | number | undefined): OcrResult['confidence'] {
    if (raw === undefined || raw === null) return 'none';
    if (typeof raw === 'number') {
        if (raw >= 75) return 'high';
        if (raw >= 50) return 'medium';
        if (raw > 0) return 'low';
        return 'none';
    }
    const c = String(raw).toLowerCase();
    if (c === 'high') return 'high';
    if (c === 'medium') return 'medium';
    if (c === 'low') return 'low';
    return 'none';
}

// ── Path helpers ───────────────────────────────────────────────────────────

function nativeScriptPath(): string {
    return path.join(__dirname, '..', 'scripts', 'ocr_text.py');
}

/**
 * Resolve Tesseract.js asset paths for VSIX compatibility.
 * In a packaged VSIX, node_modules files are flattened differently.
 * We probe several locations in order of likelihood.
 */
function resolveTesseractPath(relative: string): string {
    // Try extension path first (most reliable in packaged VSIX)
    try {
        const ext = vscode.extensions.getExtension('harmony.harmony-extension');
        if (ext) {
            const extPath = path.join(ext.extensionPath, 'node_modules', 'tesseract.js', relative);
            if (fs.existsSync(extPath)) return extPath;
            // Flat VSIX layout
            const flatPath = path.join(ext.extensionPath, relative);
            if (fs.existsSync(flatPath)) return flatPath;
        }
    } catch { /* vscode API not available */ }

    // Order of resolution: development → packaged VSIX
    const candidates = [
        path.join(__dirname, '..', 'node_modules', 'tesseract.js', relative),
        path.join(__dirname, '..', '..', 'node_modules', 'tesseract.js', relative),
        path.join(__dirname, '..', relative), // flat VSIX layout
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    // Fall back to the most likely path — Tesseract.js will try to download
    return candidates[0];
}

// ── Native OCR capability probe ────────────────────────────────────────────

/**
 * Probe whether native OCR is actually available (not just Python).
 * Tests if winrt (Windows) or pyobjc (macOS) can be imported.
 */
export function hasNativeOcr(): boolean {
    const platform = os.platform();
    if (platform !== 'win32' && platform !== 'darwin') return false;

    const probeScript = platform === 'win32'
        ? 'import winrt.windows.media.ocr; print("OK")'
        : 'import Vision; print("OK")';

    const pythonCmd = findPython();
    if (!pythonCmd) return false;

    try {
        cp.execSync(`${pythonCmd} -c "${probeScript}"`, {
            encoding: 'utf-8',
            timeout: 5000,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        return true;
    } catch {
        return false;
    }
}

function findPython(): string | null {
    try {
        cp.execSync('python --version', { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
        return 'python';
    } catch {
        try {
            cp.execSync('python3 --version', { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
            return 'python3';
        } catch {
            return null;
        }
    }
}

// ── Async native OCR (non-blocking) ────────────────────────────────────────

/**
 * Run the Python native OCR script asynchronously.
 * Returns null if native OCR is unavailable or fails.
 */
function tryNativeOcr(imagePath: string, _options?: OcrOptions): Promise<OcrResult | null> {
    const script = nativeScriptPath();
    const pythonCmd = findPython();

    if (!pythonCmd || !fs.existsSync(script)) {
        return Promise.resolve(null);
    }

    return new Promise((resolve) => {
        const child = cp.spawn(pythonCmd, [script, imagePath], {
            timeout: 30000,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        let resolved = false;

        // Hard timeout guard: kill hung process after 35s
        const timer = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                child.kill('SIGTERM');
                console.log('[OCR Engine] Native OCR timed out after 35s');
                resolve(null);
            }
        }, 35000);

        // Drain stderr to prevent buffer backpressure
        child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
        child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });

        child.on('error', (err: Error) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            console.log(`[OCR Engine] Native OCR spawn error: ${err.message}`);
            resolve(null);
        });

        child.on('close', (code: number | null) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            if (code !== 0 || !stdout.trim()) {
                console.log(`[OCR Engine] Native OCR exited ${code}: ${stderr || '(no output)'}`);
                resolve(null);
                return;
            }

            try {
                const parsed: NativeOcrJson = JSON.parse(stdout.trim());
                if (parsed.ok && parsed.engine !== 'none') {
                    resolve({
                        text: parsed.text || '',
                        confidence: normalizeConfidence(parsed.raw_confidence ?? parsed.confidence),
                        engine: parsed.engine as OcrResult['engine'],
                        lineCount: parsed.line_count ?? 0,
                        wordCount: parsed.word_count ?? 0,
                        language: parsed.language ?? '?',
                        hint: parsed.hint,
                        rawConfidence: parsed.raw_confidence,
                    });
                } else {
                    console.log(`[OCR Engine] Native OCR not available: ${parsed.hint || parsed.error || 'unknown'}`);
                    resolve(null);
                }
            } catch (e: any) {
                console.log(`[OCR Engine] Native OCR JSON parse error: ${e.message}`);
                resolve(null);
            }
        });
    });
}

// ── Tesseract.js fallback (WASM, non-blocking) ─────────────────────────────

/**
 * Run Tesseract.js OCR on the given image.
 * Pure JavaScript/WASM — works on all platforms without native dependencies.
 */
async function tryTesseractOcr(imagePath: string, options?: OcrOptions): Promise<OcrResult> {
    const language: OcrLanguage = options?.language ?? 'eng';
    let worker: any = null;

    try {
        // Lazy-load tesseract.js only when needed
        const { createWorker } = require('tesseract.js');

        worker = await createWorker(language, 1, {
            workerPath: resolveTesseractPath('dist/worker.min.js'),
            langPath: resolveTesseractPath('.'),
            corePath: resolveTesseractPath('dist/tesseract-core.wasm.js'),
            // Cache language data locally to avoid CDN downloads
            cachePath: path.join(os.tmpdir(), 'harmony-tesseract-cache'),
        });

        const { data } = await worker.recognize(imagePath);

        const conf = data.confidence || 0;
        const confidence = normalizeConfidence(conf);

        return {
            text: data.text || '',
            confidence,
            engine: 'tesseract.js',
            lineCount: data.lines?.length ?? 0,
            wordCount: (data.words || []).length,
            language,
            rawConfidence: conf,
        };
    } catch (e: any) {
        return {
            text: '',
            confidence: 'none',
            engine: 'tesseract.js',
            lineCount: 0,
            wordCount: 0,
            language,
            hint: `Tesseract.js failed: ${e?.message ?? String(e)}`,
        };
    } finally {
        // Always terminate the worker to prevent memory leaks
        if (worker) {
            try { await worker.terminate(); } catch { /* best effort */ }
        }
    }
}

// ── Main OCR entry point ───────────────────────────────────────────────────

/**
 * Run OCR on an image, trying native OCR first, then falling back to Tesseract.js.
 * Fully async — never blocks the VS Code event loop.
 *
 * @param imagePath - Absolute path to the image file.
 * @param options - Optional language and configuration.
 * @returns OcrResult with text, confidence, and engine info.
 */
export async function runOcr(imagePath: string, options?: OcrOptions): Promise<OcrResult> {
    // Step 1: Try native platform OCR (Windows / macOS)
    const nativeResult = await tryNativeOcr(imagePath, options);
    if (nativeResult) {
        return nativeResult;
    }

    // Step 2: Fall back to Tesseract.js (universal, works everywhere)
    console.log(`[OCR Engine] Falling back to Tesseract.js for: ${imagePath}`);
    return tryTesseractOcr(imagePath, options);
}

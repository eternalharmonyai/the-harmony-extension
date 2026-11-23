#!/usr/bin/env node
/**
 * Gate: Zero-Leak VPN-Resilient Gemini & Vertex AI Transport (`check:vpn-gemini-resilience`)
 *
 * Uses Node's real `http.ClientRequest` + `http.Server` wired over deterministic in-memory
 * `Duplex` socket pairs (zero OS port binding or external network calls, so it runs cleanly
 * inside networkless sandboxes and CI).
 *
 * Verifies:
 *   1. Zero-Leak VPN & TLS Security Invariants:
 *      - `localAddress` is NEVER set (100% OS VPN routing & encrypted DNS preserved).
 *      - Explicit proxies (`HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, editor `http.proxy`)
 *        are strictly honored (with `NO_PROXY` + loopback exclusions) and delegate to
 *        proxy-aware `fetch` so proxy-mode VPNs are NEVER bypassed.
 *      - Remote `https:` requests strictly enforce `rejectUnauthorized: true` and SNI
 *        `servername` even if `tlsRejectUnauthorized: false` is passed.
 *   2. 4-Phase Socket Lifecycle, Paced `16 KB` Upload & Pre-Header IPv4 Self-Heal:
 *      - Pre-header socket drop (`serverSock.destroy()`) auto-heals immediately on a fresh
 *        unpooled IPv4 request (`agent: false`, `family: 4`, `Connection: close`), marks the
 *        host for sticky fresh IPv4, and emits `onGuardEvent` (`AGENTS.md` §6).
 *      - `210 KB` payload uploads in paced slices (`setNoDelay(true)`, `setKeepAlive(true, 15000)`,
 *        explicit `Content-Length`, `Accept-Encoding: identity` for SSE) and arrives byte-for-byte.
 *      - Phase 1 (`connect_tls` stall) and Phase 2 (`upload_stall` blackhole) abort rapidly
 *        with `VpnTransportPhaseError` instead of hanging 180s.
 *      - Early `HTTP 401` with `Content-Encoding: gzip` during a `256 KB` upload resolves
 *        cleanly without throwing write-side `EPIPE` and decompresses gzipped JSON.
 *      - `evictIdleVpnSockets()` evicts idle pooled sockets without disrupting active streams.
 *   3. Gemini Native Frontier TTFB Floor & Zero-Delta Early SSE Drop Self-Heal:
 *      - `resolveGeminiTtfbMs` grants `240s` post-upload floor to `gemini-4-carbon` /
 *        `gemini-4-argon` by default while honoring explicit user `ttfbTimeoutSec` values.
 *      - `callGeminiNativeStreaming` self-heals a zero-delta early SSE drop (`HTTP 200`
 *        headers flushed, then socket reset before any token) with `onGuardEvent`, while
 *        NEVER duplicating partial output once any delta has been emitted.
 *   4. VPN Rebind Error Codes & Phase Diagnostics (`resilience.ts` + `chatParticipant.ts` + `vertexAuth.ts`).
 */

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const zlib = require('zlib');
const Module = require('module');
const { Duplex, PassThrough } = require('stream');

const root = path.resolve(__dirname, '..');

let mockHarmonySettings = {};
let mockHttpSettings = {};
let mockInspectedSettings = {};

const vscodeStub = {
    EventEmitter: class VscodeEventEmitter {
        constructor() {
            this.event = () => ({ dispose() {} });
        }
        fire() {}
        dispose() {}
    },
    workspace: {
        workspaceFolders: [],
        getConfiguration: (section) => ({
            get: (key, def) => {
                const map = section === 'http' ? mockHttpSettings : mockHarmonySettings;
                return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : def;
            },
            inspect: (key) => {
                if (section === 'harmony' && Object.prototype.hasOwnProperty.call(mockInspectedSettings, key)) {
                    return mockInspectedSettings[key];
                }
                return undefined;
            },
        }),
    },
    window: {
        createOutputChannel: (name) => ({
            name,
            append() {},
            appendLine() {},
            clear() {},
            show() {},
            hide() {},
            dispose() {},
        }),
        showWarningMessage: () => Promise.resolve(undefined),
    },
};

const origHttpsRequest = https.request;
const origHttpRequest = http.request;
let activeHttpsRequestHook = null;
https.request = function dispatchHttpsRequest(...args) {
    if (activeHttpsRequestHook) {
        return activeHttpsRequestHook(...args);
    }
    return origHttpsRequest.apply(this, args);
};

const origLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'vscode') return vscodeStub;
    return origLoad.call(this, request, parent, isMain);
};

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
    if (condition) {
        passed += 1;
        console.log(`  PASS  ${label}`);
    } else {
        failed += 1;
        console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    }
}

/**
 * Creates a bidirectional in-memory Duplex socket pair so real `http.ClientRequest`
 * and real `http.Server` speak HTTP/1.1 without OS socket syscalls.
 */
function createInMemorySocketPair(pairOpts = {}) {
    const hwm = pairOpts.highWaterMark || 16384;
    const c2s = new PassThrough({ highWaterMark: hwm });
    const s2c = new PassThrough({ highWaterMark: hwm });

    function makeSide(readableSide, writableSide, isClient) {
        let waitingReadable = false;
        const sock = new Duplex({
            highWaterMark: hwm,
            read() {
                const chunk = readableSide.read();
                if (chunk !== null) {
                    this.push(chunk);
                } else if (!waitingReadable) {
                    waitingReadable = true;
                    readableSide.once('readable', () => {
                        waitingReadable = false;
                        this._read();
                    });
                }
            },
            write(chunk, enc, cb) {
                if (isClient && Array.isArray(pairOpts.clientWriteSizes)) {
                    pairOpts.clientWriteSizes.push(chunk.length);
                }
                if (isClient && pairOpts.stallClientWrites) {
                    // Simulate full kernel send buffer / VPN MTU blackhole (never ACK write)
                    return;
                }
                writableSide.write(chunk, enc, cb);
            },
            final(cb) {
                if (isClient && pairOpts.stallClientWrites) {
                    return;
                }
                writableSide.end(cb);
            },
            destroy(err, cb) {
                readableSide.destroy();
                writableSide.destroy();
                cb(err);
            },
        });
        readableSide.once('end', () => {
            try { sock.push(null); } catch {}
        });
        readableSide.once('close', () => {
            if (!sock.destroyed) {
                sock.destroy();
            }
        });
        sock.connecting = Boolean(pairOpts.neverHandshake);
        sock.noDelayCalls = [];
        sock.keepAliveCalls = [];
        sock.setNoDelay = (v) => {
            sock.noDelayCalls.push(v);
            return sock;
        };
        sock.setKeepAlive = (enable, delay) => {
            sock.keepAliveCalls.push([enable, delay]);
            return sock;
        };
        sock.setTimeout = () => sock;
        sock.ref = () => sock;
        sock.unref = () => sock;
        if (isClient) {
            if (pairOpts.tcpConnectedTlsPending) {
                // Node v22 OpenSSL state right after TCP connect before TLS finishes:
                // connecting === false, secureConnecting === true, getProtocol() === 'TLSv1.3'
                sock.connecting = false;
                sock.secureConnecting = true;
                sock.getProtocol = () => 'TLSv1.3';
            } else {
                sock.secureConnecting = Boolean(pairOpts.neverHandshake);
                sock.getProtocol = () => (sock.connecting || sock.secureConnecting ? null : 'TLSv1.3');
                if (!pairOpts.neverHandshake) {
                    sock.connecting = true;
                    sock.secureConnecting = true;
                    process.nextTick(() => {
                        if (!sock.destroyed) {
                            sock.connecting = false;
                            sock.emit('connect');
                            sock.secureConnecting = false;
                            sock.emit('secureConnect');
                        }
                    });
                }
            }
        }
        return sock;
    }

    const clientSock = makeSide(s2c, c2s, true);
    const serverSock = makeSide(c2s, s2c, false);
    return { clientSock, serverSock };
}

/**
 * Temporarily routes `https.request` through an in-memory `http.Server` (or custom
 * connection handler) while capturing the exact `https.RequestOptions` passed by
 * `vpnResilientTransport.ts`.
 */
async function withInMemoryHttpsHarness(handlerOrPairFactory, runFn) {
    const capturedOpts = [];
    const clientSockets = [];
    const server = typeof handlerOrPairFactory === 'function' && handlerOrPairFactory.length === 2
        ? http.createServer(handlerOrPairFactory)
        : null;

    activeHttpsRequestHook = function hookedHttpsRequest(opts, cb) {
        capturedOpts.push(opts);
        const pairSpec = server
            ? {}
            : handlerOrPairFactory(capturedOpts.length, opts);
        const { clientSock, serverSock } = createInMemorySocketPair(pairSpec || {});
        clientSockets.push(clientSock);

        if (server) {
            server.emit('connection', serverSock);
        } else if (pairSpec && typeof pairSpec.onServerSocket === 'function') {
            pairSpec.onServerSocket(serverSock);
        }

        const memAgent = new http.Agent({ keepAlive: false });
        memAgent.createConnection = () => clientSock;

        return origHttpRequest(
            {
                protocol: 'http:',
                hostname: '127.0.0.1',
                port: 443,
                path: opts.path || '/',
                method: opts.method || 'POST',
                headers: { Host: opts.hostname || 'localhost', ...(opts.headers || {}) },
                agent: memAgent,
            },
            cb
        );
    };

    try {
        return await runFn({ capturedOpts, clientSockets });
    } finally {
        activeHttpsRequestHook = null;
        for (const s of clientSockets) {
            try { s.destroy(); } catch {}
        }
    }
}

async function main() {
    console.log('\n[check-vpn-gemini-resilience] Verifying Zero-Leak VPN-Resilient Gemini & Vertex Transport...');

    const vpnModPath = path.join(root, 'out', 'vpnResilientTransport.js');
    const geminiModPath = path.join(root, 'out', 'geminiNativeStreaming.js');
    const resilienceModPath = path.join(root, 'out', 'resilience.js');

    check(
        'compiled modules exist (vpnResilientTransport, geminiNativeStreaming, resilience)',
        fs.existsSync(vpnModPath) && fs.existsSync(geminiModPath) && fs.existsSync(resilienceModPath),
        'run npm run compile first'
    );
    if (!fs.existsSync(vpnModPath)) process.exit(1);

    const {
        VpnTransportPhaseError,
        vpnResilientFetch,
        isExplicitProxyActiveForUrl,
        evictIdleVpnSockets,
        shouldVpnHostPreferFreshIpv4,
        resetVpnTransportStateForTests,
    } = require(vpnModPath);
    const {
        resolveGeminiTtfbMs,
        resolveGeminiIdleMs,
        callGeminiNativeStreaming,
    } = require(geminiModPath);
    const {
        classifyTransient,
        describeTransientPhase,
    } = require(resilienceModPath);

    const vertexUrl =
        'https://aiplatform.googleapis.com/v1beta1/projects/demo-proj/locations/global/publishers/google/models/gemini-4-carbon:streamGenerateContent?alt=sse';

    // ── 1. Zero-Leak VPN, Proxy & Remote TLS Invariants ──────────────────
    {
        const vpnSrc = fs.readFileSync(path.join(root, 'src', 'vpnResilientTransport.ts'), 'utf8');
        const codeOnly = vpnSrc.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
        check(
            'vpnResilientTransport never sets localAddress (100% OS VPN routing preserved)',
            !/\blocalAddress\b/.test(codeOnly)
        );

        check(
            'isExplicitProxyActiveForUrl detects HTTPS_PROXY / explicit http.proxy and honors NO_PROXY + loopback',
            isExplicitProxyActiveForUrl(vertexUrl, { env: {} }) === false &&
                isExplicitProxyActiveForUrl(vertexUrl, { env: { HTTPS_PROXY: 'http://127.0.0.1:8080' } }) === true &&
                isExplicitProxyActiveForUrl(vertexUrl, { env: {}, explicitProxySetting: 'http://127.0.0.1:8080' }) === true &&
                isExplicitProxyActiveForUrl(vertexUrl, {
                    env: { HTTPS_PROXY: 'http://127.0.0.1:8080', NO_PROXY: '.googleapis.com,localhost' },
                }) === false &&
                isExplicitProxyActiveForUrl('http://127.0.0.1:8789/api/chat', {
                    env: { HTTPS_PROXY: 'http://127.0.0.1:8080' },
                    explicitProxySetting: 'http://127.0.0.1:8080',
                }) === false
        );

        // Proxy-mode VPN must delegate to proxy-aware fetch and NEVER call raw https.request
        let proxyDelegatedCalls = 0;
        let rawHttpsCalledDuringProxy = false;
        const origGlobalFetch = globalThis.fetch;
        try {
            activeHttpsRequestHook = function disallowRawHttps() {
                rawHttpsCalledDuringProxy = true;
                throw new Error('raw https.request must not run when proxy is active');
            };
            globalThis.fetch = async () => {
                proxyDelegatedCalls += 1;
                return new Response('{"ok":true}', { status: 200 });
            };
            const proxyRes = await vpnResilientFetch(vertexUrl, {
                method: 'POST',
                body: '{}',
                explicitProxySetting: 'http://127.0.0.1:8888',
            });
            check(
                'Proxy-mode VPN delegates strictly to proxy-aware fetch without calling raw https.request',
                proxyRes.status === 200 && proxyDelegatedCalls === 1 && rawHttpsCalledDuringProxy === false
            );
        } finally {
            activeHttpsRequestHook = null;
            globalThis.fetch = origGlobalFetch;
        }

        // Remote HTTPS strictly enforces rejectUnauthorized: true + SNI even when tlsRejectUnauthorized: false is passed
        resetVpnTransportStateForTests();
        await withInMemoryHttpsHarness(
            (req, res) => {
                req.resume();
                req.on('end', () => {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end('{"ok":true}');
                });
            },
            async ({ capturedOpts }) => {
                const res = await vpnResilientFetch(vertexUrl, {
                    method: 'POST',
                    body: '{}',
                    tlsRejectUnauthorized: false, // Must be ignored on non-loopback host!
                    env: {},
                });
                await res.text();
                const opts = capturedOpts[0];
                check(
                    'Remote HTTPS strictly enforces rejectUnauthorized: true, SNI servername, and undefined localAddress',
                    Boolean(
                        opts &&
                            opts.rejectUnauthorized === true &&
                            opts.servername === 'aiplatform.googleapis.com' &&
                            opts.localAddress === undefined
                    ),
                    JSON.stringify(opts)
                );
            }
        );
        resetVpnTransportStateForTests();
    }

    // ── 2. Pre-Header Socket Drop Self-Heal, 16KB Paced 210KB Upload & KeepAlive ──
    {
        resetVpnTransportStateForTests();
        const largePayload = JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: 'V'.repeat(210 * 1024) }] }],
        });
        let connCount = 0;
        let receivedBytes = Buffer.alloc(0);
        const guardReasons = [];

        await withInMemoryHttpsHarness(
            (req, res) => {
                connCount += 1;
                if (connCount === 1) {
                    // Simulate dead VPN socket / channel-switch reset before response headers
                    req.socket.destroy();
                    return;
                }
                const chunks = [];
                req.on('data', (c) => chunks.push(c));
                req.on('end', () => {
                    receivedBytes = Buffer.concat(chunks);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, bytes: receivedBytes.byteLength }));
                });
            },
            async ({ capturedOpts, clientSockets }) => {
                const res = await vpnResilientFetch(vertexUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: largePayload,
                    env: {},
                    onGuardEvent: (r) => guardReasons.push(r),
                });
                const bodyJson = await res.json();
                const expectedLen = Buffer.byteLength(largePayload, 'utf8');
                const attempt1Opts = capturedOpts[0];
                const attempt2Opts = capturedOpts[1];
                const sock2 = clientSockets[1];

                check(
                    'Pre-header socket drop self-heals on fresh unpooled IPv4 (agent:false, family:4, Connection:close) + delivers 210KB byte-for-byte',
                    res.status === 200 &&
                        connCount === 2 &&
                        bodyJson.bytes === expectedLen &&
                        receivedBytes.toString('utf8') === largePayload &&
                        attempt1Opts.autoSelectFamily === true &&
                        attempt2Opts.agent === false &&
                        attempt2Opts.family === 4 &&
                        attempt2Opts.headers.Connection === 'close' &&
                        attempt2Opts.headers['Content-Length'] === String(expectedLen) &&
                        attempt2Opts.headers['Accept-Encoding'] === 'identity' &&
                        sock2.noDelayCalls.includes(true) &&
                        sock2.keepAliveCalls.some(([en, ms]) => en === true && ms === 15_000) &&
                        shouldVpnHostPreferFreshIpv4('aiplatform.googleapis.com') === true &&
                        guardReasons.length === 1,
                    `connCount=${connCount}, guardReasons=${JSON.stringify(guardReasons)}`
                );
            }
        );
        resetVpnTransportStateForTests();
    }

    // ── 3. Phase 1 (connect_tls), Phase 2 (upload_stall) & Early HTTP 401 Gzip ──
    {
        // 3a. Phase 1 connect/TLS stall (tunnel route or IPv6 blackhole before secureConnect)
        let connectErr = null;
        await withInMemoryHttpsHarness(
            () => ({ neverHandshake: true }),
            async () => {
                try {
                    await vpnResilientFetch(vertexUrl, {
                        method: 'POST',
                        body: '{}',
                        connectTimeoutMs: 70,
                        ttfbTimeoutMs: 5_000,
                        autoHealPreHeaderFailure: false,
                        env: {},
                    });
                } catch (e) {
                    connectErr = e;
                }
            }
        );
        check(
            'Phase 1 connect/TLS stall aborts rapidly with VpnTransportPhaseError(connect_tls)',
            Boolean(connectErr instanceof VpnTransportPhaseError && connectErr.phase === 'connect_tls'),
            connectErr ? `${connectErr.phase}: ${connectErr.message}` : 'did not throw'
        );
        resetVpnTransportStateForTests();

        // 3b. Phase 2 upload stall (MTU blackhole on large upload after TLS handshake succeeds)
        let uploadErr = null;
        const startUploadMs = Date.now();
        await withInMemoryHttpsHarness(
            () => ({ stallClientWrites: true, highWaterMark: 4096 }),
            async () => {
                try {
                    await vpnResilientFetch(vertexUrl, {
                        method: 'POST',
                        body: Buffer.alloc(128 * 1024, 0x61),
                        connectTimeoutMs: 2_000,
                        uploadTimeoutMs: 90,
                        ttfbTimeoutMs: 10_000,
                        autoHealPreHeaderFailure: false,
                        env: {},
                    });
                } catch (e) {
                    uploadErr = e;
                }
            }
        );
        const uploadElapsed = Date.now() - startUploadMs;
        check(
            'Phase 2 blackholed upload aborts rapidly (<1.5s) via VpnTransportPhaseError(upload_stall) instead of hanging 180s',
            Boolean(
                uploadErr instanceof VpnTransportPhaseError &&
                    uploadErr.phase === 'upload_stall' &&
                    uploadElapsed < 1_500
            ),
            uploadErr ? `${uploadErr.phase}: ${uploadErr.message} (${uploadElapsed}ms)` : 'did not throw'
        );
        resetVpnTransportStateForTests();

        // 3c. Early HTTP 401 with Content-Encoding: gzip while client is still uploading 256 KB
        const gzipErrorJson = JSON.stringify({
            error: { code: 401, status: 'UNAUTHENTICATED', message: 'Token expired' },
        });
        const compressed401 = zlib.gzipSync(Buffer.from(gzipErrorJson, 'utf8'));
        await withInMemoryHttpsHarness(
            (req, res) => {
                res.writeHead(401, {
                    'Content-Type': 'application/json',
                    'Content-Encoding': 'gzip',
                    Connection: 'close',
                });
                res.end(compressed401, () => {
                    try { req.socket.destroy(); } catch {}
                });
            },
            async () => {
                const r401 = await vpnResilientFetch('https://oauth2.googleapis.com/token', {
                    method: 'POST',
                    body: Buffer.alloc(256 * 1024, 0x78),
                    env: {},
                });
                const decoded401 = await r401.text();
                check(
                    'Early HTTP 401 during 256KB upload resolves cleanly (no EPIPE) and decompresses gzip body',
                    r401.status === 401 && JSON.parse(decoded401).error.status === 'UNAUTHENTICATED'
                );
            }
        );
        resetVpnTransportStateForTests();
    }

    // ── 4. Active Stream Immunity During evictIdleVpnSockets() ───────────
    {
        await withInMemoryHttpsHarness(
            (req, res) => {
                req.resume();
                req.on('end', () => {
                    res.writeHead(200, { 'Content-Type': 'text/plain' });
                    res.write('part-1:');
                    setTimeout(() => {
                        evictIdleVpnSockets();
                        res.end('part-2');
                    }, 40);
                });
            },
            async () => {
                const slowRes = await vpnResilientFetch(vertexUrl, {
                    method: 'POST',
                    body: '{}',
                    env: {},
                });
                const fullText = await slowRes.text();
                check(
                    'evictIdleVpnSockets() never disrupts concurrent active in-flight streams',
                    fullText === 'part-1:part-2'
                );
            }
        );
        resetVpnTransportStateForTests();
    }

    // ── 5. Frontier 240s TTFB Floor & Zero-Delta Early SSE Drop Self-Heal ──
    {
        mockHarmonySettings = {};
        mockInspectedSettings = {};
        const cfg = vscodeStub.workspace.getConfiguration('harmony');
        check(
            'resolveGeminiTtfbMs grants 240s post-upload floor to Argon/Carbon/Neon by default and 180s to Flash/Hydrogen',
            resolveGeminiTtfbMs(cfg, undefined, 'gemini-4-carbon') === 240_000 &&
                resolveGeminiTtfbMs(cfg, undefined, 'models/gemini-4-argon') === 240_000 &&
                resolveGeminiTtfbMs(cfg, undefined, 'gemini-4-neon') === 240_000 &&
                resolveGeminiTtfbMs(cfg, undefined, 'gemini-4-hydrogen') === 180_000 &&
                resolveGeminiTtfbMs(cfg, undefined, 'gemini-3.6-flash') === 180_000
        );

        mockHarmonySettings = { ttfbTimeoutSec: 95 };
        mockInspectedSettings = { ttfbTimeoutSec: { globalValue: 95 } };
        const customCfg = vscodeStub.workspace.getConfiguration('harmony');
        check(
            'resolveGeminiTtfbMs honors explicit user ttfbTimeoutSec overrides on Argon/Carbon',
            resolveGeminiTtfbMs(customCfg, undefined, 'gemini-4-carbon') === 95_000 &&
                resolveGeminiTtfbMs(customCfg, 42_000, 'gemini-4-carbon') === 42_000
        );
        mockHarmonySettings = {};
        mockInspectedSettings = {};

        check(
            'resolveGeminiIdleMs grants 300s mid-stream buffered functionCall floor to Argon/Carbon/Neon when tools are active (even if default 120 was saved)',
            resolveGeminiIdleMs(cfg, undefined, 'gemini-4-carbon', true) === 300_000 &&
                resolveGeminiIdleMs(cfg, undefined, 'models/gemini-4-argon', true) === 300_000 &&
                resolveGeminiIdleMs(cfg, undefined, 'gemini-4-neon', true) === 300_000 &&
                resolveGeminiIdleMs(cfg, undefined, 'gemini-4-carbon', false) === 120_000 &&
                resolveGeminiIdleMs(cfg, undefined, 'gemini-3.6-flash', true) === 120_000
        );
        mockHarmonySettings = { streamIdleTimeoutSec: 120 };
        mockInspectedSettings = { streamIdleTimeoutSec: { globalValue: 120 } };
        const savedDefaultIdleCfg = vscodeStub.workspace.getConfiguration('harmony');
        check(
            'resolveGeminiIdleMs treats saved default 120s in globalValue as non-narrowing for Argon/Carbon tool synthesis',
            resolveGeminiIdleMs(savedDefaultIdleCfg, undefined, 'gemini-4-carbon', true) === 300_000
        );
        mockHarmonySettings = { streamIdleTimeoutSec: 90 };
        mockInspectedSettings = { streamIdleTimeoutSec: { globalValue: 90 } };
        const customIdleCfg = vscodeStub.workspace.getConfiguration('harmony');
        check(
            'resolveGeminiIdleMs honors explicit user streamIdleTimeoutSec overrides on Argon/Carbon',
            resolveGeminiIdleMs(customIdleCfg, undefined, 'gemini-4-carbon', true) === 90_000 &&
                resolveGeminiIdleMs(customIdleCfg, 45_000, 'gemini-4-carbon', true) === 45_000
        );
        mockHarmonySettings = {};
        mockInspectedSettings = {};

        // 5b. Zero-delta early SSE drop over https://generativelanguage.googleapis.com:
        // Connection #1 flushes 200 OK headers then resets socket before emitting any SSE token;
        // Connection #2 streams thought + content cleanly!
        let sseAttempts = 0;
        mockHarmonySettings = {
            'gemini.endpointProfile': 'ai-studio',
            enableDebugLogging: false,
        };
        const cancelToken = {
            isCancellationRequested: false,
            onCancellationRequested: () => ({ dispose() {} }),
        };
        const testApiKey = ['AIza', 'InMemoryTestKey012345'].join('');
        const sseGuardEvents = [];
        const streamedChunks = [];

        await withInMemoryHttpsHarness(
            (req, res) => {
                sseAttempts += 1;
                req.resume();
                req.on('end', () => {
                    res.writeHead(200, {
                        'Content-Type': 'text/event-stream',
                        'Cache-Control': 'no-cache',
                    });
                    res.flushHeaders();
                    if (sseAttempts === 1) {
                        setTimeout(() => {
                            try { req.socket.destroy(); } catch {}
                        }, 15);
                        return;
                    }
                    res.write('data: {"candidates":[{"content":{"role":"model","parts":[{"thought":true,"text":"Thinking inside tunnel..."}]}}]}\n\n');
                    res.write('data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Zero-delta SSE drop healed!"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":20,"candidatesTokenCount":5,"thoughtsTokenCount":4}}\n\n');
                    res.end();
                });
            },
            async () => {
                const result = await callGeminiNativeStreaming(
                    'gemini-4-carbon',
                    testApiKey,
                    [{ role: 'user', content: 'Verify zero-delta SSE heal' }],
                    [],
                    cancelToken,
                    (d) => {
                        if (d.content) streamedChunks.push(d.content);
                    },
                    {
                        ttfbTimeoutMs: 3_000,
                        streamIdleTimeoutMs: 3_000,
                        onGuardEvent: (reason) => sseGuardEvents.push(reason),
                    }
                );
                check(
                    'callGeminiNativeStreaming self-heals zero-delta early SSE stream drop + fires onGuardEvent',
                    sseAttempts === 2 &&
                        sseGuardEvents.length === 1 &&
                        sseGuardEvents[0].includes('SSE stream dropped before first delta') &&
                        result.content === 'Zero-delta SSE drop healed!' &&
                        result.reasoning === 'Thinking inside tunnel...' &&
                        streamedChunks.join('') === 'Zero-delta SSE drop healed!'
                );
            }
        );
        resetVpnTransportStateForTests();

        // 5c. Negative safety control: once any delta HAS been emitted, mid-stream drop must NOT duplicate text
        let partialAttempts = 0;
        let partialErr = null;
        const partialEmitted = [];
        await withInMemoryHttpsHarness(
            (req, res) => {
                partialAttempts += 1;
                req.resume();
                req.on('end', () => {
                    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                    res.write('data: {"candidates":[{"content":{"role":"model","parts":[{"text":"AlreadyVisible "}]}}]}\n\n');
                    setTimeout(() => {
                        try { req.socket.destroy(new Error('mid-stream ECONNRESET')); } catch {}
                    }, 20);
                });
            },
            async () => {
                try {
                    await callGeminiNativeStreaming(
                        'gemini-4-carbon',
                        testApiKey,
                        [{ role: 'user', content: 'Partial drop test' }],
                        [],
                        cancelToken,
                        (d) => {
                            if (d.content) partialEmitted.push(d.content);
                        },
                        {
                            ttfbTimeoutMs: 3_000,
                            streamIdleTimeoutMs: 3_000,
                        }
                    );
                } catch (err) {
                    partialErr = err;
                }
            }
        );
        mockHarmonySettings = {};
        resetVpnTransportStateForTests();
        check(
            'Mid-stream drop AFTER visible delta bubbles out cleanly without duplicating partial output',
            partialAttempts === 1 &&
                partialEmitted.join('') === 'AlreadyVisible ' &&
                Boolean(partialErr),
            `partialAttempts=${partialAttempts}, emitted=${JSON.stringify(partialEmitted)}, err=${partialErr && partialErr.message}`
        );
    }

    // ── 6. VPN Rebind Codes, Phase Diagnostics & Cross-Module Wiring ──────
    {
        const eConnect = new VpnTransportPhaseError('connect_tls', 'Gemini connect/TLS handshake timed out after 15s');
        const eUpload = new VpnTransportPhaseError('upload_stall', 'Gemini request upload stalled after 30s');
        const eTtfb = new VpnTransportPhaseError('ttfb_timeout', 'Gemini request timed out before the first response bytes (240s).');
        const eRebind = Object.assign(new Error('connect ENETUNREACH'), { code: 'ENETUNREACH' });
        const eDns = Object.assign(new Error('getaddrinfo EAI_AGAIN aiplatform.googleapis.com'), { code: 'EAI_AGAIN' });
        const e400 = new Error('Gemini Native HTTP 400: invalid argument');

        check(
            'classifyTransient & describeTransientPhase distinguish VPN phases and rebind codes while rejecting 400',
            classifyTransient(eConnect).transient === true &&
                describeTransientPhase(eConnect) === 'connect/TLS stalled on tunnel' &&
                classifyTransient(eUpload).transient === true &&
                describeTransientPhase(eUpload) === 'request upload stalled (VPN/MTU blackhole)' &&
                classifyTransient(eTtfb).transient === true &&
                describeTransientPhase(eTtfb) === 'first-byte response timeout' &&
                classifyTransient(eRebind).transient === true &&
                describeTransientPhase(eRebind) === 'VPN/network route rebinding' &&
                classifyTransient(eDns).transient === true &&
                describeTransientPhase(eDns) === 'VPN/network route rebinding' &&
                classifyTransient(e400).transient === false
        );

        const providersSrc = fs.readFileSync(path.join(root, 'src', 'providers.ts'), 'utf8');
        const vertexAuthSrc = fs.readFileSync(path.join(root, 'src', 'vertexAuth.ts'), 'utf8');
        const chatSrc = fs.readFileSync(path.join(root, 'src', 'chatParticipant.ts'), 'utf8');
        const visionSrc = fs.readFileSync(path.join(root, 'src', 'visionRouter.ts'), 'utf8');
        check(
            'vpnResilientFetch, proxy forwarding & visible phase diagnostics are wired across providers, vertexAuth, visionRouter & chatParticipant',
            providersSrc.includes('vpnResilientFetch(') &&
                providersSrc.includes('getVscodeHttpProxyOptions') &&
                vertexAuthSrc.includes('vpnResilientFetch(') &&
                vertexAuthSrc.includes('explicitProxySetting: options.explicitProxySetting') &&
                visionSrc.includes('vpnResilientFetch(') &&
                chatSrc.includes('vpnResilientFetch(') &&
                chatSrc.includes('describeTransientPhase(') &&
                chatSrc.includes('stream.progress(reason)')
        );

        // 7. Triple-Check Regression Guards (Pre-Aborted Signal, Node v22 secureConnecting, proxySupport:off, Redaction, Sticky Clear)
        {
            // 7a. Pre-aborted AbortSignal must reject cleanly with AbortError and zero uncaught ClientRequest error
            const preAborted = new AbortController();
            preAborted.abort();
            let abortCaught = null;
            await withInMemoryHttpsHarness(
                () => ({}),
                async ({ capturedOpts }) => {
                    try {
                        await vpnResilientFetch(vertexUrl, {
                            method: 'POST',
                            body: '{}',
                            signal: preAborted.signal,
                            env: {},
                        });
                    } catch (e) {
                        abortCaught = e;
                    }
                    check(
                        'Pre-aborted AbortSignal rejects cleanly with AbortError without opening a ClientRequest',
                        Boolean(abortCaught && abortCaught.name === 'AbortError' && capturedOpts.length === 0)
                    );
                }
            );

            // 7b. Node v22 TLSSocket state (connecting: false, secureConnecting: true, getProtocol: TLSv1.3) still enforces Phase 1 connect_tls
            let tlsPendingErr = null;
            await withInMemoryHttpsHarness(
                () => ({ tcpConnectedTlsPending: true }),
                async () => {
                    try {
                        await vpnResilientFetch(vertexUrl, {
                            method: 'POST',
                            body: '{}',
                            connectTimeoutMs: 70,
                            ttfbTimeoutMs: 5_000,
                            autoHealPreHeaderFailure: false,
                            env: {},
                        });
                    } catch (e) {
                        tlsPendingErr = e;
                    }
                }
            );
            check(
                'Node v22 secureConnecting===true socket stays guarded by Phase 1 connect_tls timer',
                Boolean(tlsPendingErr instanceof VpnTransportPhaseError && tlsPendingErr.phase === 'connect_tls')
            );
            resetVpnTransportStateForTests();

            // 7c. http.proxySupport === 'off' disables proxy delegation even when HTTPS_PROXY / explicitProxySetting are set
            check(
                'isExplicitProxyActiveForUrl honors proxySupport="off"',
                isExplicitProxyActiveForUrl(vertexUrl, {
                    env: { HTTPS_PROXY: 'http://127.0.0.1:8080' },
                    explicitProxySetting: 'http://127.0.0.1:8080',
                    proxySupport: 'off',
                }) === false
            );

            // 7d. Comprehensive credential redaction (Bearer tokens, access_token, refresh_token, client_secret, x-goog-api-key) while preserving prose
            const { redactUrlCredentials } = require(path.join(root, 'out', 'vertexAuth.js'));
            const { unwrapTransportErrorChain, markVpnHostPreferFreshIpv4 } = require(vpnModPath);
            const fakeBearer = ['ya29.', 'SyntheticSecretBearerTokenValue987654'].join('');
            const fakeRefresh = ['1//04', 'SyntheticRefreshTokenValue987654'].join('');
            const fakeApiKey = ['AIza', 'SyntheticSecretHeaderValue1234'].join('');
            const sampleErrText = [
                `POST https://generativelanguage.googleapis.com/v1beta/models/m?key=${fakeApiKey}&access_token=${fakeBearer}`,
                `Authorization: Bearer ${fakeBearer}`,
                `x-goog-api-key: ${fakeApiKey}`,
                `{"refresh_token":"${fakeRefresh}","client_secret":"topSecretVal123"}`,
                'OAuth Bearer authentication on Vertex AI requires a GCP Project ID.',
            ].join(' | ');
            const redacted = redactUrlCredentials(sampleErrText);
            const unwrappedRedacted = unwrapTransportErrorChain(new Error(sampleErrText));
            check(
                'redactUrlCredentials & unwrapTransportErrorChain scrub Bearer, access_token, refresh_token, client_secret & x-goog-api-key while preserving prose',
                !redacted.includes(fakeBearer) &&
                    !redacted.includes(fakeRefresh) &&
                    !redacted.includes(fakeApiKey) &&
                    !redacted.includes('topSecretVal123') &&
                    !unwrappedRedacted.includes(fakeBearer) &&
                    redacted.includes('OAuth Bearer authentication on Vertex AI')
            );

            // 7e. Bounded retry multiplication & IPv6-only NAT64 sticky clear when preferIpv4 Phase 1 fails
            resetVpnTransportStateForTests();
            markVpnHostPreferFreshIpv4('aiplatform.googleapis.com');
            await withInMemoryHttpsHarness(
                () => ({ neverHandshake: true }),
                async ({ capturedOpts }) => {
                    try {
                        await vpnResilientFetch(vertexUrl, {
                            method: 'POST',
                            body: '{}',
                            connectTimeoutMs: 50,
                            env: {},
                        });
                    } catch {
                        // expected Phase 1 failure
                    }
                    check(
                        'Already-sticky fresh IPv4 runs 1 attempt (no redundant 0ms double-retry) and clears sticky IPv4 on Phase-1 handshake failure',
                        capturedOpts.length === 1 &&
                            shouldVpnHostPreferFreshIpv4('aiplatform.googleapis.com') === false
                    );
                }
            );
            resetVpnTransportStateForTests();
        }
    }

    console.log(`\n[check-vpn-gemini-resilience] ${passed} passed, ${failed} failed.`);
    if (failed > 0) process.exit(1);
}

main().catch((err) => {
    console.error('[check-vpn-gemini-resilience] Fatal error:', err);
    process.exit(1);
});

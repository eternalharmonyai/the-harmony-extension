/**
 * Preload that makes any network call throw. Used by the hermetic CI job so the
 * hermetic/integration split is MACHINE-ENFORCED rather than a comment that rots:
 * a suite that quietly gains a network dependency fails here instead of becoming
 * an intermittent failure in the job that gates merges.
 *
 *   node -r ./scripts/lib/no-network.js scripts/run-provenance-<suite>.js
 */
const boom = (what) => () => {
    throw new Error(
        `[no-network] ${what} was called in a HERMETIC suite. Either stub it, or move ` +
        `this suite to the integration tier in .github/workflows/provenance.yml.`
    );
};
globalThis.fetch = boom('fetch()');
try {
    const http = require('http'), https = require('https');
    http.request = boom('http.request()');
    https.request = boom('https.request()');
    http.get = boom('http.get()');
    https.get = boom('https.get()');
} catch { /* best effort */ }

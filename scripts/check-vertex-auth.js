#!/usr/bin/env node
/**
 * Gate: Google Cloud Vertex AI Superpositioned Authentication & Routing
 *
 * Verifies:
 *   1. Env OAuth Bearer token (GOOGLE_OAUTH_ACCESS_TOKEN) overrides a saved AI Studio AIza* key on Vertex.
 *   2. Service Account JSON (GOOGLE_APPLICATION_CREDENTIALS & secret JSON) signs a valid RS256 JWT,
 *      exchanges it for a cached Bearer token, and auto-populates project_id.
 *   3. Google Cloud ADC (application_default_credentials.json authorized_user) exchanges refresh_token,
 *      caches the Bearer token, and reads quota_project_id / gcloud config_default project.
 *   4. gcloud CLI fallback (gcloud auth print-access-token) mints & caches Bearer token + project.
 *   5. Vertex AI Express API keys (AQ.* and VERTEX_API_KEY) include both ?key= (or ?alt=sse&key=)
 *      on aiplatform.googleapis.com and x-goog-api-key header.
 *   6. Project-scoped Vertex AI without GCP OAuth throws VertexAuthConfigurationError instead of
 *      sending an AI Studio AIza* key to projects/{project}/...
 *   7. Vertex OpenAI-compat (/endpoints/openapi) requires OAuth Bearer + projectId and prefixes "google/".
 *   8. Error enrichment & URL credential redaction never leak ?key= secrets and guide AIza* users clearly.
 *   9. chatParticipant.ts never falls back to OpenAI-compat on 401/403/404/429 or VertexAuthConfigurationError,
 *      and records ledger route_guard events (AGENTS.md §6).
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const compiledVertexAuth = path.join(root, 'out', 'vertexAuth.js');
const chatParticipantSrc = path.join(root, 'src', 'chatParticipant.ts');

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

async function main() {
    console.log('\n[check-vertex-auth] Verifying Vertex AI authentication & routing...');

    if (!fs.existsSync(compiledVertexAuth)) {
        console.error(`Missing compiled module: ${compiledVertexAuth}. Run "npm run compile" first.`);
        process.exit(1);
    }

    const va = require(compiledVertexAuth);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harmony-vertex-auth-test-'));
    const savedAiStudioFixtureKey = ['AIza', 'SySavedTestFixtureKey123456'].join('');

    try {
        // 1. Env OAuth Bearer overrides saved AIza* key (Bug 2B fix)
        va.invalidateVertexTokenCache();
        const envBearerAuth = await va.resolveVertexAuthAsync({
            apiKey: savedAiStudioFixtureKey,
            configuredProjectId: 'my-vertex-proj',
            configuredLocation: 'us-central1',
            env: { GOOGLE_OAUTH_ACCESS_TOKEN: 'ya29.EnvTokenOverridesAiStudioKey' },
            allowAmbientGcloud: false,
        });
        check(
            'GOOGLE_OAUTH_ACCESS_TOKEN overrides saved AIza* key on Vertex',
            envBearerAuth.mode === 'bearer'
                && envBearerAuth.source === 'env-bearer-token'
                && envBearerAuth.bearerToken === 'ya29.EnvTokenOverridesAiStudioKey'
                && envBearerAuth.projectId === 'my-vertex-proj'
        );
        const builtEnvBearer = va.buildVertexGenerateContentEndpoint('gemini-4-carbon', 'streamGenerateContent', true, envBearerAuth);
        check(
            'Regional project-scoped Vertex URL + Bearer header constructed cleanly',
            builtEnvBearer.url === 'https://us-central1-aiplatform.googleapis.com/v1beta1/projects/my-vertex-proj/locations/us-central1/publishers/google/models/gemini-4-carbon:streamGenerateContent?alt=sse'
                && builtEnvBearer.headers['Authorization'] === 'Bearer ya29.EnvTokenOverridesAiStudioKey'
                && !builtEnvBearer.headers['x-goog-api-key']
        );

        // 2. Service Account JSON RS256 JWT minting + caching + auto project_id
        const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
            modulusLength: 2048,
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        });
        const saFile = path.join(tempDir, 'service-account.json');
        fs.writeFileSync(saFile, JSON.stringify({
            type: 'service_account',
            project_id: 'sa-discovered-project',
            client_email: 'harmony-bot@sa-discovered-project.iam.gserviceaccount.com',
            private_key: privateKey,
            token_uri: 'https://oauth2.googleapis.com/token',
        }), 'utf8');

        let saFetchCalls = 0;
        let verifiedJwtSignature = false;
        const mockSaFetch = async (url, init) => {
            saFetchCalls += 1;
            const params = new URLSearchParams(init.body);
            const assertion = params.get('assertion') || '';
            const [h, p, s] = assertion.split('.');
            const verifier = crypto.createVerify('RSA-SHA256');
            verifier.update(`${h}.${p}`);
            verifier.end();
            verifiedJwtSignature = verifier.verify(publicKey, Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
            return {
                ok: true,
                status: 200,
                text: async () => JSON.stringify({ access_token: 'ya29.MintedFromServiceAccountJwt', expires_in: 3600 }),
            };
        };

        const saAuth1 = await va.resolveVertexAuthAsync({
            apiKey: savedAiStudioFixtureKey,
            env: { GOOGLE_APPLICATION_CREDENTIALS: saFile },
            fetchImpl: mockSaFetch,
            allowAmbientGcloud: false,
        });
        const saAuth2 = await va.resolveVertexAuthAsync({
            apiKey: savedAiStudioFixtureKey,
            env: { GOOGLE_APPLICATION_CREDENTIALS: saFile },
            fetchImpl: mockSaFetch,
            allowAmbientGcloud: false,
        });
        check(
            'Service Account JSON signs verifiable RS256 JWT, mints Bearer token, and auto-reads project_id',
            verifiedJwtSignature === true
                && saAuth1.mode === 'bearer'
                && saAuth1.source === 'google-application-credentials'
                && saAuth1.bearerToken === 'ya29.MintedFromServiceAccountJwt'
                && saAuth1.projectId === 'sa-discovered-project'
        );
        check(
            'Minted Service Account OAuth token is cached across calls (1 network call for 2 resolutions)',
            saFetchCalls === 1 && saAuth2.bearerToken === 'ya29.MintedFromServiceAccountJwt'
        );

        // 3. Google Cloud ADC (authorized_user) + gcloud config_default project discovery
        const gcloudDir = path.join(tempDir, 'gcloud');
        fs.mkdirSync(path.join(gcloudDir, 'configurations'), { recursive: true });
        fs.writeFileSync(path.join(gcloudDir, 'configurations', 'config_default'), '[core]\naccount = dev@example.com\nproject = gcloud-default-proj-42\n', 'utf8');
        fs.writeFileSync(path.join(gcloudDir, 'application_default_credentials.json'), JSON.stringify({
            type: 'authorized_user',
            client_id: 'test-client-id.apps.googleusercontent.com',
            client_secret: 'test-client-secret',
            refresh_token: '1//0test-refresh-token-value',
        }), 'utf8');

        check(
            'hasVertexAmbientCredentialsSync detects application_default_credentials.json synchronously',
            va.hasVertexAmbientCredentialsSync({ env: {}, gcloudConfigDir: gcloudDir }) === true
        );

        let adcFetchCalls = 0;
        const adcAuth = await va.resolveVertexAuthAsync({
            apiKey: savedAiStudioFixtureKey,
            env: {},
            gcloudConfigDir: gcloudDir,
            fetchImpl: async () => {
                adcFetchCalls += 1;
                return {
                    ok: true,
                    status: 200,
                    text: async () => JSON.stringify({ access_token: 'ya29.MintedFromAdcRefreshToken', expires_in: 3600 }),
                };
            },
        });
        check(
            'gcloud ADC refresh_token mints Bearer token and discovers project from gcloud config_default',
            adcFetchCalls === 1
                && adcAuth.mode === 'bearer'
                && adcAuth.source === 'gcloud-adc'
                && adcAuth.bearerToken === 'ya29.MintedFromAdcRefreshToken'
                && adcAuth.projectId === 'gcloud-default-proj-42'
        );

        // 4. gcloud CLI fallback when ADC JSON is absent but credentials.db exists
        const gcloudCliDir = path.join(tempDir, 'gcloud-cli');
        fs.mkdirSync(gcloudCliDir, { recursive: true });
        fs.writeFileSync(path.join(gcloudCliDir, 'credentials.db'), 'sqlite-placeholder', 'utf8');
        va.invalidateVertexTokenCache();
        const cliAuth = await va.resolveVertexAuthAsync({
            apiKey: '',
            env: {},
            gcloudConfigDir: gcloudCliDir,
            execCommandImpl: async (cmd) => cmd === 'print-access-token'
                ? 'ya29.FromGcloudCliPrintAccessToken123456'
                : 'cli-discovered-project',
        });
        check(
            'gcloud CLI fallback resolves Bearer token and project when no key or ADC file exists',
            cliAuth.mode === 'bearer'
                && cliAuth.source === 'gcloud-cli'
                && cliAuth.bearerToken === 'ya29.FromGcloudCliPrintAccessToken123456'
                && cliAuth.projectId === 'cli-discovered-project'
        );

        // 5. Vertex AI Express Mode API key (AQ.*) attaches ?alt=sse&key= and x-goog-api-key
        const expressAuth = await va.resolveVertexAuthAsync({
            apiKey: 'AQ.Ab8RN6ExpressTestKey999',
            env: {},
            allowAmbientGcloud: false,
        });
        const expressEndpoint = va.buildVertexGenerateContentEndpoint('gemini-4-carbon', 'streamGenerateContent', true, expressAuth);
        check(
            'Vertex Express AQ.* key attaches ?alt=sse&key= query param + x-goog-api-key header',
            expressAuth.mode === 'api-key'
                && expressAuth.source === 'secret-vertex-express-key'
                && expressEndpoint.url === 'https://aiplatform.googleapis.com/v1beta1/publishers/google/models/gemini-4-carbon:streamGenerateContent?alt=sse&key=AQ.Ab8RN6ExpressTestKey999'
                && expressEndpoint.headers['x-goog-api-key'] === 'AQ.Ab8RN6ExpressTestKey999'
                && !expressEndpoint.headers['Authorization']
        );

        // 6. Project-scoped Vertex AI with ONLY an AI Studio AIza* key throws VertexAuthConfigurationError
        const blockedProjAuth = await va.resolveVertexAuthAsync({
            apiKey: 'AIzaSyAiStudioOnlyKey',
            configuredProjectId: 'strict-enterprise-proj',
            env: {},
            allowAmbientGcloud: false,
        });
        let threwConfigErr = false;
        try {
            va.buildVertexGenerateContentEndpoint('gemini-4-carbon', 'streamGenerateContent', true, blockedProjAuth);
        } catch (err) {
            threwConfigErr = err instanceof va.VertexAuthConfigurationError && /gcloud auth application-default login/.test(err.message);
        }
        check(
            'Project-scoped Vertex AI refuses AIza* key cleanly with VertexAuthConfigurationError guidance',
            blockedProjAuth.mode === 'none' && threwConfigErr
        );

        // 7. Vertex OpenAI-compat endpoint requires Bearer + projectId and prefixes google/
        const compatFromBearer = va.buildVertexOpenAiCompatEndpoint('gemini-4-carbon', envBearerAuth);
        const compatFromExpress = va.buildVertexOpenAiCompatEndpoint('gemini-4-carbon', expressAuth);
        check(
            'Vertex OpenAI-compat builds /endpoints/openapi + google/ model prefix for OAuth+Project and returns undefined for Express API key',
            compatFromBearer
                && compatFromBearer.baseUrl === 'https://us-central1-aiplatform.googleapis.com/v1beta1/projects/my-vertex-proj/locations/us-central1/endpoints/openapi'
                && compatFromBearer.model === 'google/gemini-4-carbon'
                && compatFromBearer.bearerToken === 'ya29.EnvTokenOverridesAiStudioKey'
                && compatFromExpress === undefined
        );

        // 8. URL key redaction & AIza 401 enrichment
        const fallbackAiza = await va.resolveVertexAuthAsync({
            apiKey: 'AIzaSyAiStudioOnlyKey',
            env: {},
            allowAmbientGcloud: false,
        });
        const enriched401 = va.enrichVertexHttpError(
            401,
            'UNAUTHENTICATED at https://aiplatform.googleapis.com/v1beta1/publishers/google/models/gemini-4-carbon:streamGenerateContent?alt=sse&key=AIzaSySecretLeakTest',
            'gemini-4-carbon',
            fallbackAiza
        );
        check(
            'enrichVertexHttpError redacts ?key= secrets and explains AI Studio vs Vertex AI auth',
            !enriched401.includes('AIzaSySecretLeakTest')
                && enriched401.includes('key=[REDACTED]')
                && enriched401.includes('Vertex Auth Guidance')
        );

        // 9. Static invariant on chatParticipant.ts: no blind compat fallback on 401/403/404/429 + ledger route_guard recorded
        const cpText = fs.readFileSync(chatParticipantSrc, 'utf8');
        check(
            'chatParticipant.ts guards against OpenAI-compat fallback on 401/403/404/429 and logs route_guard to ledger',
            cpText.includes('isNonCompatRecoverableNativeError')
                && cpText.includes('recordRouteGuardEvent')
                && cpText.includes('resolveGeminiOpenAiCompatRequestAsync')
        );

        // 10. Cross-surface Harmony Sovereign Vault (%LOCALAPPDATA%\Harmony\vertex-credentials.json)
        //     works across VS Code, Standalone 8789, and CLI while preserving saved AIza* keys & hiding OS usernames.
        const vaultDir = path.join(tempDir, 'sovereign-vault');
        const vaultSaved = va.writeVertexVaultCredentials(JSON.stringify({
            type: 'service_account',
            project_id: 'vault-project-id',
            client_email: 'harmony-vault@vault-project-id.iam.gserviceaccount.com',
            private_key: privateKey,
            token_uri: 'https://oauth2.googleapis.com/token',
        }), { vaultDir });
        check(
            'writeVertexVaultCredentials validates Service Account JSON and returns unexpanded displayPath (no username leak)',
            vaultSaved.present === true
                && vaultSaved.projectId === 'vault-project-id'
                && vaultSaved.clientEmail === 'harmony-vault@vault-project-id.iam.gserviceaccount.com'
                && (vaultSaved.displayPath.includes('%LOCALAPPDATA%') || vaultSaved.displayPath.includes('$XDG_CONFIG_HOME'))
                && !vaultSaved.displayPath.includes(tempDir)
        );
        check(
            'hasVertexAmbientCredentialsSync detects Harmony Sovereign Vault synchronously',
            va.hasVertexAmbientCredentialsSync({ env: {}, vaultDir, gcloudConfigDir: path.join(tempDir, 'empty-gcloud') }) === true
        );
        const vaultResolved = await va.resolveVertexAuthAsync({
            apiKey: savedAiStudioFixtureKey,
            env: {},
            vaultDir,
            fetchImpl: mockSaFetch,
            allowAmbientGcloud: false,
        });
        check(
            'Harmony Sovereign Vault overrides saved AIza* key on Vertex without overwriting AI Studio key',
            vaultResolved.mode === 'bearer'
                && vaultResolved.source === 'harmony-vault'
                && vaultResolved.projectId === 'vault-project-id'
        );
        const cleared = va.clearVertexVaultCredentials({ vaultDir });
        check(
            'clearVertexVaultCredentials removes vault cleanly',
            cleared === true && va.isVertexVaultPresent({ vaultDir }) === false
        );

        // 11. Dedicated-VM Hard Road-Lock (allowDedicatedVmEndpoints default false)
        let blockedDedicatedVm = false;
        try {
            va.buildVertexGenerateContentEndpoint(
                'projects/my-vertex-proj/locations/us-central1/endpoints/9876543210',
                'streamGenerateContent',
                true,
                envBearerAuth
            );
        } catch (err) {
            blockedDedicatedVm = err instanceof va.VertexDedicatedVmBlockedError;
        }
        const allowedDedicatedWhenExplicit = va.buildVertexGenerateContentEndpoint(
            'projects/my-vertex-proj/locations/us-central1/endpoints/9876543210',
            'streamGenerateContent',
            true,
            envBearerAuth,
            { allowDedicatedVmEndpoints: true }
        );
        check(
            'Dedicated-VM Road-Lock blocks /endpoints/<vm-id> by default and only allows when allowDedicatedVmEndpoints=true',
            blockedDedicatedVm === true
                && allowedDedicatedWhenExplicit.url.includes('/endpoints/9876543210:streamGenerateContent')
        );

        // 12. Google Workspace invalid_rapt detection & clear guidance
        const raptErr = new va.VertexAuthConfigurationError('Auth failed', [
            'gcloud ADC failed: ADC OAuth HTTP 400: {"error":"invalid_grant","error_subtype":"invalid_rapt"}',
        ]);
        check(
            'isVertexInvalidRaptError detects Google Workspace RAPT expiration cleanly',
            va.isVertexInvalidRaptError(raptErr) === true
                && va.isVertexInvalidRaptError('normal network error') === false
        );

        // 13. Strict Unofficial Cost Estimate Disclaimer exported & rendered
        const costSrc = fs.readFileSync(path.join(root, 'src', 'costTracker.ts'), 'utf8');
        const sidebarSrc = fs.readFileSync(path.join(root, 'src', 'sidebar.ts'), 'utf8');
        check(
            'Strict UNOFFICIAL ESTIMATE ONLY liability disclaimer is exported in costTracker and rendered in sidebar',
            costSrc.includes('export const UNOFFICIAL_COST_ESTIMATE_DISCLAIMER')
                && costSrc.includes('CHECK YOUR PROVIDER BILLING CONSOLE BETWEEN MESSAGES')
                && sidebarSrc.includes('UNOFFICIAL ESTIMATE ONLY')
        );
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }

    console.log(`\n[check-vertex-auth] ${passed} passed, ${failed} failed.`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});

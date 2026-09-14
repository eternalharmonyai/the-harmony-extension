/**
 * Test-key generation and cleanup, in one place.
 *
 * Generates Ed25519 keypairs (principal + recovery) directly in Node via WebCrypto —
 * no external tooling — and writes the three artifacts each suite consumes:
 *
 *   <name>.key          principal PKCS8 PEM private key
 *   <name>.recovery.key recovery PKCS8 PEM private key
 *   <name>.pub          text: signer / algorithm / public_key / recovery_public_key
 *
 * All three live under a local, gitignored test-key directory and are swept up after
 * every run, so no private key material lingers on disk.
 */
const fs = require('fs');
const path = require('path');
const { webcrypto } = require('node:crypto');

const KEYS_ROOT = path.resolve(__dirname, '..', '..', '.harmony', 'test-keys');

function signerKeyPaths(signer) {
    return [
        path.join(KEYS_ROOT, 'private', `${signer}.key`),
        path.join(KEYS_ROOT, 'private', `${signer}.recovery.key`),
        path.join(KEYS_ROOT, `${signer}.pub`),
    ];
}

function pemEncode(der) {
    const b64 = Buffer.from(der).toString('base64').match(/.{1,64}/g).join('\n');
    return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
}

const hex = bytes => Buffer.from(bytes).toString('hex');

/** Generate a principal + recovery keypair and write all three artifacts. */
async function generateSignerKeys(signer) {
    const alg = { name: 'Ed25519' };
    const principal = await webcrypto.subtle.generateKey(alg, true, ['sign', 'verify']);
    const recovery = await webcrypto.subtle.generateKey(alg, true, ['sign', 'verify']);

    const principalPem = pemEncode(await webcrypto.subtle.exportKey('pkcs8', principal.privateKey));
    const recoveryPem = pemEncode(await webcrypto.subtle.exportKey('pkcs8', recovery.privateKey));
    const principalPubHex = hex(await webcrypto.subtle.exportKey('raw', principal.publicKey));
    const recoveryPubHex = hex(await webcrypto.subtle.exportKey('raw', recovery.publicKey));

    const [privPath, recPath, pubPath] = signerKeyPaths(signer);
    fs.mkdirSync(path.dirname(privPath), { recursive: true });
    fs.mkdirSync(path.dirname(pubPath), { recursive: true });
    fs.writeFileSync(privPath, principalPem, 'utf8');
    fs.writeFileSync(recPath, recoveryPem, 'utf8');
    fs.writeFileSync(pubPath,
        `signer: ${signer}\nalgorithm: ed25519\npublic_key: ${principalPubHex}\nrecovery_public_key: ${recoveryPubHex}\n`,
        'utf8');

    return { privPath, recPath, pubPath };
}

/** Remove every key artifact for the given signers. Never throws. */
function removeSignerKeys(...signers) {
    for (const signer of signers) {
        for (const p of signerKeyPaths(signer)) {
            try { fs.rmSync(p, { force: true }); } catch { /* best effort */ }
        }
    }
}

module.exports = { signerKeyPaths, generateSignerKeys, removeSignerKeys };

# Security Policy

## Reporting a Vulnerability

**Do not open a public issue.** Instead, email the maintainers directly.

We take security seriously. If you discover a vulnerability in the Harmony Extension, please report it privately so we can address it before public disclosure.

### What to include

- A clear description of the vulnerability
- Steps to reproduce (if possible)
- Affected versions
- Any potential impact or exploit scenarios

### What to expect

- **Acknowledgment**: Within 72 hours
- **Initial assessment**: Within 5 business days
- **Fix timeline**: Depends on severity; critical issues prioritized immediately
- **Credit**: We're happy to credit reporters in release notes (with your permission)

## Scope

The Harmony Extension security policy covers:

- The VS Code/Cursor extension code in this repository
- The HarmonyHub local daemon (distributed separately)
- Provider API key handling and storage

## Responsible Disclosure

We follow coordinated disclosure. Please give us reasonable time to address a vulnerability before any public discussion. We commit to transparency about security fixes in release notes.

## Known Limitations

- Harmony stores API keys in VS Code's `SecretStorage`. These are encrypted at rest by VS Code.
- The HarmonyHub daemon runs locally on `127.0.0.1` and does not accept external connections.
- Provider API calls go directly from your machine to the provider — Harmony does not proxy or log API traffic.

## Supply Chain

- This extension is distributed as a `.vsix` file and via the VS Code Marketplace.
- Dependencies are locked via `package.json` and `package-lock.json`.
- Verify the publisher `eternalharmonyai` before installing from the marketplace.

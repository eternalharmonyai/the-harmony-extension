# Contributing to the Harmony Extension

Thank you for your interest in contributing! Harmony is an open-source VS Code extension built with the [Hippocratic License 3.0](LICENSE.txt). We welcome thoughtful contributions that align with ethical AI development.

## 🌱 First Steps

1. **Read the [README](README.md)** — it covers what Harmony does, how to install from source, and the provider ecosystem.
2. **Check open issues** — look for `good first issue` or `help wanted` labels.
3. **Start a discussion** — for larger changes, open an issue first so we can align before you invest time.

## 🔧 Development Setup

```bash
# Clone
git clone https://github.com/eternalharmonyai/the-harmony-extension
cd the-harmony-extension

# Install dependencies
npm install

# Compile TypeScript → JavaScript
npm run compile

# Package into .vsix (optional VS Code/Cursor install)
npm run package
```

**Requirements:**
- Node.js 18+
- npm 9+
- VS Code or Cursor (for testing)

The extension compiles to `out/`. Reload your editor window after installing to pick up changes.

## 📁 Project Structure

| Path | Purpose |
|------|---------|
| `src/` | TypeScript source |
| `src/sidebar.ts` | Harmony panel UI (webview provider) |
| `src/extension.ts` | Extension activation, commands, message routing |
| `src/chatParticipant.ts` | Chat participant (`@harmony`) logic |
| `src/visionRouter.ts` | Image/vision model routing |
| `src/visualTools.ts` | Image generation and local image analysis |
| `src/lmTools.ts` | Language model tool implementations |
| `src/providers.ts` | Provider API clients |
| `media/` | Extension icons and assets |
| `scripts/` | Utility scripts (OCR, proxy, etc.) |
| `docs/` | Architecture and roadmap documents |

## 🚦 Pull Request Process

1. Fork the repository and create a feature branch from `main`.
2. Make your changes. Keep PRs focused — one concern per PR.
3. Run `npm run compile` and ensure zero TypeScript errors.
4. Run `npm run package` and verify the VSIX builds cleanly.
5. Open a PR with a clear description of what changed and why.
6. PRs require one maintainer review before merge.

## ⚖️ Legal & Ethical Commitments

By contributing, you agree that:

- Your contributions are licensed under the [Hippocratic License 3.0](LICENSE.txt).
- You will not introduce code that violates provider terms of service, enables abuse of AI APIs, or intentionally harms end users.
- You will not include personally identifying information (PII), private keys, tokens, or credentials in commits. Use `.env` files and the `.gitignore` for secrets.
- If your contribution touches provider API code, you will document the pricing implications in the PR description.

## 🔒 Security

See [SECURITY.md](SECURITY.md) for reporting vulnerabilities. Do not disclose security issues in public issues.

## 💬 Code of Conduct

- Be respectful and collaborative. We're building tools that serve people — including neurodivergent, disabled, and marginalized communities.
- Assume good intent. Ask clarifying questions before assuming malice.
- No harassment, discrimination, or toxic behavior. Maintainers reserve the right to moderate.
- Focus on the work — not on personal identity, beliefs, or affiliation.

## ❓ Questions?

Open a [GitHub Discussion](https://github.com/eternalharmonyai/the-harmony-extension/discussions) or file an issue. We're happy to help.

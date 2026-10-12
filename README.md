# Hermes Local IDE

Local VS Code extension that chats with your existing **Hermes** agent over ACP (`hermes acp`).

Adapted fork of [formulahendry/vscode-acp](https://github.com/formulahendry/vscode-acp) (MIT, © Jun Han). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Changes from upstream

- Hermes-only default agent (`hermes` + `["acp"]`)
- No telemetry
- No remote agent registry
- No npx / `@latest` launchers
- Direct spawn with `shell: false`
- Permissions always ask (dismiss → deny)
- Client fs/terminal capabilities not advertised
- Traffic logging off by default

Hermes remains the agent harness. This extension does not call the model API directly.

## Install on any VS Code / Cursor

### From a GitHub Release (recommended)

1. Open the repo **Releases** page.
2. Download `hermes-ide-0.1.0.vsix`.
3. In VS Code or Cursor: `Ctrl+Shift+P` → **Extensions: Install from VSIX…** → pick the file.
4. Reload, open the **Hermes** activity bar → connect **Hermes Agent**.

Or from a terminal on that machine:

```bash
code --install-extension ./hermes-ide-0.1.0.vsix
# Cursor:
cursor --install-extension ./hermes-ide-0.1.0.vsix
```

### Build locally from source

```bash
npm install
npm run package
npx vsce package --no-dependencies
code --install-extension hermes-ide-0.1.0.vsix
```

Fallback: `hermes` / `hermes acp --check` in a terminal.

## Docs

- [docs/compatibility.md](docs/compatibility.md)
- [docs/security-and-offline.md](docs/security-and-offline.md)

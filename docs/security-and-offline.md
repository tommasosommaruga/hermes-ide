# Security and offline

- Webview: CSP `default-src 'none'`, nonce scripts, no remote assets
- Extension host only bridges ACP; Hermes executes tools with OS user permissions
- Telemetry and registry CDN removed
- npx/@latest rejected; spawn uses `shell: false`
- Auto-approve removed; dismiss maps to deny when possible
- After install, extension needs no cloud for chat; local model endpoint still required
- Not a sandbox — use a restricted OS account for sensitive work

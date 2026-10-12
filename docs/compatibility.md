# ACP compatibility

- Hermes ACP: JSON-RPC NDJSON stdio, `PROTOCOL_VERSION = 1`
- Launch: `hermes acp` (or configured absolute path)
- Supported: initialize, authenticate, session new/prompt/cancel, load/list/resume/fork when advertised, streaming updates, permission requests
- Not advertised: client `fs/*`, client `terminal/*` (Hermes tools stay in-process)
- Model stays in Hermes config (e.g. local Qwen at `127.0.0.1:8080`)

## Limitations

- Cron/messaging/full TUI not exposed via ACP editor toolset
- Extension does not start the model server
- Hermes web/browser tools can still use the network if invoked

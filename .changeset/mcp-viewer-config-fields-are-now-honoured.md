---
"@ifc-lite/mcp": patch
---

Fix `ServerConfig.autoOpenViewer` / `.viewerPort` being declared on the public
`MCPServer` config type but never read by the server (issue #2731, finding 4).

`MCPServer` takes `config: Partial<ServerConfig>` in its constructor, and the
sibling fields `readOnly`, `bsddEndpoint`, `samplingEnabled` and
`allowedPaths` are honoured via `ctx.config.*` — but `autoOpenViewer` and
`viewerPort` were not. The CLI's own `--viewer` / `--viewer-port` auto-open
behaviour came entirely from separate local variables (`opts.autoViewer`,
`opts.viewerPort`) that happened to be written into `config` but never read
back out of it. An embedder constructing `MCPServer` directly with
`config: { autoOpenViewer: true }` got nothing, silently.

Adds `MCPServer.maybeAutoOpenViewer(overrides?)`, which opens the in-process
viewer for the first loaded model when configured to do so and no-ops
otherwise. Precedence: an explicit `overrides` argument (what a CLI flag
represents) beats `this.config` (set at construction, e.g. by an embedder)
beats the built-in default (no auto-open, port 0). The CLI now calls this
method with `{ autoOpen: opts.autoViewer, port: opts.viewerPort }` instead of
calling `server.viewer.open()` directly, so its `--viewer` / `--viewer-port`
behaviour is unchanged but now goes through the same config-aware path any
other caller gets.

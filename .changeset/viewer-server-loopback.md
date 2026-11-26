---
"@ifc-lite/viewer-core": minor
"@ifc-lite/cli": minor
"@ifc-lite/mcp": minor
---

The local viewer server (`ifc-lite view`, the MCP `--viewer`) listens on 127.0.0.1 only. It refuses requests whose Host is not `localhost`, `127.0.0.1` or `[::1]`, which blocks DNS rebinding, and refuses requests sent from pages on other sites. Opening the viewer page itself from a link or an IDE preview still works, and a `frame-ancestors` policy keeps other sites from framing it (only pages opened as `localhost` or `127.0.0.1`, and desktop VS Code-family preview panes, may embed it; see https://ifclite.dev/docs/guide/viewer-api/). For requests, pages served from any local port count as local, and browsers without Fetch Metadata (Safari before 16.4) can still embed its read routes. Before, it listened on every interface and ran `/api/command`, `/api/create` and `/api/clear-created` for any page that posted to it. The CLI and the MCP server now dial `127.0.0.1` instead of `localhost`, so they still connect where `localhost` resolves to `::1` first.

If you opened the viewer from another machine, forward the port over SSH from that machine instead (`ssh -L 3456:127.0.0.1:3456 host`, where `host` runs the viewer) and open `http://127.0.0.1:3456` locally. A viewer inside a container can no longer be reached from outside it: a published port (`docker run -p 3456:3456`) does not reach the container's loopback, and neither does a hosted forward such as GitHub Codespaces, which sends its own Host name. There is no opt-out yet.

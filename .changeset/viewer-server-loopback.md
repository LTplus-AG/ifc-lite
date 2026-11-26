---
"@ifc-lite/viewer-core": minor
"@ifc-lite/cli": minor
"@ifc-lite/mcp": minor
---

The local viewer server (`ifc-lite view`, the MCP `--viewer`) listens on 127.0.0.1 only. It refuses requests whose Host is not `localhost`, `127.0.0.1` or `[::1]`, which blocks DNS rebinding, and refuses requests sent from pages on other sites. Opening the viewer page itself from a link or an IDE preview still works. Pages served from any local port count as local, and browsers without Fetch Metadata (Safari before 16.4) can still embed its read routes. Before, it listened on every interface and ran `/api/command`, `/api/create` and `/api/clear-created` for any page that posted to it. The CLI and the MCP server now dial `127.0.0.1` instead of `localhost`, so they still connect where `localhost` resolves to `::1` first.

If you opened the viewer from another machine or from outside a container, forward the port over SSH instead (`ssh -L 3456:127.0.0.1:3456 host`) and open `http://127.0.0.1:3456` locally. A published container port (`docker run -p 3456:3456`) no longer reaches the viewer, and neither does a hosted forward such as GitHub Codespaces, which sends its own Host name. There is no opt-out yet.

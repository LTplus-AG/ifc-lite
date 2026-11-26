---
"@ifc-lite/viewer-core": minor
"@ifc-lite/cli": minor
"@ifc-lite/mcp": patch
---

The local viewer server (`ifc-lite view`, the MCP `--viewer`) listens on 127.0.0.1 only. It refuses requests whose Host is not its own loopback address, which blocks DNS rebinding, and refuses POSTs sent from pages on other sites. Before, it listened on every interface and ran `/api/command`, `/api/create` and `/api/clear-created` for any page that posted to it. The CLI and the MCP server now dial `127.0.0.1` instead of `localhost`, so they still connect where `localhost` resolves to `::1` first.

If you opened the viewer from another machine or from outside a container, forward the port over SSH instead (`ssh -L 3456:127.0.0.1:3456 host`) and open `http://localhost:3456` locally.

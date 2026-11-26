---
"@ifc-lite/viewer": patch
---

The local viewer server (`ifc-lite view`, the MCP `--viewer`) listens on 127.0.0.1 only. It refuses requests whose Host is not its own loopback address, which blocks DNS rebinding, and refuses POSTs sent from pages on other sites. Before, it listened on every interface and ran `/api/command`, `/api/create` and `/api/clear-created` for any page that posted to it.

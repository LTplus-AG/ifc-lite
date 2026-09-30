---
"@ifc-lite/mutations": minor
"@ifc-lite/sdk": major
"@ifc-lite/mcp": minor
"@ifc-lite/sandbox": minor
"@ifc-lite/create": patch
---

Expose canonical atomic wall joins through SDK, sandbox and MCP. Protect hosted cuts at joined end faces and use shared compound recording to restore complete earlier overlay graphs in one undo.

The SDK backend contract now requires `StoreBackendMethods.joinWalls`. Third-party backends must implement this method when upgrading.

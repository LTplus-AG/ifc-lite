---
"@ifc-lite/mutations": minor
"@ifc-lite/sdk": major
"@ifc-lite/mcp": minor
"@ifc-lite/sandbox": minor
"@ifc-lite/create": major
---

Expose canonical atomic wall joins through SDK, sandbox and MCP. Protect hosted cuts at joined end faces and use shared compound recording to restore complete earlier overlay graphs in one undo.

The SDK backend contract now requires `StoreBackendMethods.joinWalls`. Third-party backends must implement this method when upgrading.

`joinWallsInStore` now refuses unreadable hosted opening geometry and cuts that would extend beyond either joined end face. These calls previously succeeded, so callers must handle the expanded runtime error contract when upgrading `@ifc-lite/create`.

---
"@ifc-lite/sdk": patch
---

The headless session (SDK, CLI and MCP) now reads back what it authored before export (#9296). `bim.materials()`, `bim.classifications()`, `bim.documents()` and `bim.typeProperties()` used to read only the model as parsed, so a material, a layer set usage, an `IfcRelDefinesByType` or a type property set added in the session showed up only after export and reopen. The shared headless query adapter now passes the live mutation view to the parser's material, classification and document resolvers. Type data follows the session's effective type relationship and the type's property sets, edits included. A session that only reads keeps the store-only path.

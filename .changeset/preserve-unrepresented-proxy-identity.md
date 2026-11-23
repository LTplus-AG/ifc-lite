---
'@ifc-lite/export': patch
'@ifc-lite/wasm': patch
---

Preserve GlobalId and Name when schema conversion writes an unrepresented entity as an IfcProxy. The TypeScript and Rust writers now use the same deterministic fallback when the source GlobalId is missing or invalid.

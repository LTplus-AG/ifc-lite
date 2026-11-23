---
'@ifc-lite/export': patch
'@ifc-lite/wasm': patch
---

Preserve GlobalId and Name when schema conversion writes an unrepresented entity as an IfcProxy. The TypeScript and Rust writers now use the same deterministic fallback when the source GlobalId is missing or invalid.

Merged exports keep conversion-created proxies distinct when a GUID is shared. If a model repeats a GUID, its first emitted record retains that GUID.

---
"@ifc-lite/wasm": patch
---

The diff engine's native comparison is faster. `DiffModelHandle.compare` and `diffModels` spend less time matching entities and component hashes: about 60% less native work on a 17,000-object revision and about 45% less on AC20-FZK-Haus. Results are unchanged (#8351).

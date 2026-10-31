---
"@ifc-lite/wasm": patch
"@ifc-lite/diff": patch
---

Diff comparisons are faster. `DiffModelHandle.compare` and `diffModels` spend less time matching entities and component hashes, no longer rebuild the default class families on every call, and pass only the options a caller set across the WASM boundary. In native timing the comparison work drops by about 60% on a 17,000-object revision and by about 70% on AC20-FZK-Haus. Results are unchanged (#8351).

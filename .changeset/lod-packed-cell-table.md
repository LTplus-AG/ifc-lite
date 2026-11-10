---
"@ifc-lite/renderer": patch
---

LOD1 simplification (`simplifyIndicesByClustering`) keeps its packed (entity, cell) keys in a typed open-addressing table instead of a `Map`. A `Map` boxes each 53-bit key as a heap double. The output is unchanged: the same first-vertex representative wins each cell, and the rare out-of-neighbourhood cells keep their exact string keys. LOD clustering was about a fifth of a cold load's finalize CPU. With the table it costs roughly a third of that on large models (Holter 214 → 78 ms, BWK 331 → 113 ms of profiled self time in a replay of the real stream).

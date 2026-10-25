---
"@ifc-lite/diff": minor
---

Preserve distinct identity and lineage sidecar claims containing NUL or U+0001 key code units, and reject conflicts previously hidden by deduplication (#8088).

Conflicting claims that delimiter collisions previously hid now reach validation and throw.

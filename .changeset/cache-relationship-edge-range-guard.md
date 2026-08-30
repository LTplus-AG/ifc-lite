---
'@ifc-lite/cache': patch
---

Fail loudly when a cached RelationshipGraph's per-entity edge range is corrupted, instead of silently returning edges with `undefined` fields.

The relationships section stores each entity's edges as an `(offset, count)` pair into a shared edge-target/type/relationshipId array. Nothing validated that pair against the array's actual length: a cache file corrupted between write and read (disk bitrot, a truncated write, a hand-edited file) could carry an `offset + count` that overruns the edge arrays. `getEdges()` would then read past the end of a `Uint32Array`/`Uint16Array`, which JavaScript resolves to `undefined` rather than throwing, and return relationship edges with `undefined` target/type/relationshipId mixed in with the real ones — silent corruption reaching callers with no signal anything went wrong.

`readRelationships`/`readEdges` now validate every entity's `(offset, count)` range against the edge array length right after parsing, and throw a descriptive "Corrupt cache RelationshipGraph" error if it doesn't fit — the same fail-fast contract already applied to this cache format's other sections (StringTable offsets, entity-index typeIndex, InstancedShards lengths).

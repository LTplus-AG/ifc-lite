---
"@ifc-lite/ifcx": patch
---

fix(ifcx): stop duplicating geometry for entities with multiple incoming
containment edges. A node reachable through more than one parent (e.g. a
wall hanging under both its storey and a space boundary, as the IFC5
exporter legitimately emits) was traversed once per incoming edge and its
mesh emitted each time — an export round-trip multiplied per-entity
triangle counts by the number of edges (Hello Wall: ×4). Extraction now
deduplicates per (node path, entity context, accumulated transform), so
aliased containment edges emit once while shared type bodies referenced
from multiple instances and genuine instancing still emit per context.

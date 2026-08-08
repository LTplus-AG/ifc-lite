---
"@ifc-lite/collab": patch
---

Fix `promoteEntityType` silently discarding data when its target path already exists. `createEntity` is documented as idempotent — a pre-existing path is a no-op that returns the existing entity unchanged — but `promoteEntityType` deletes the source path unconditionally before calling it. If the target already existed (e.g. seeded by a concurrent peer, or a prior promotion that landed on the same path), the call reported success with a truthy `Y.Map` while the source entity's carried attributes, children and meta were permanently lost and the target kept its stale data. `promoteEntityType` now throws before deleting the source when the target path is already occupied, matching this file's existing convention of throwing on precondition violations (`setAttribute`, `setChild`, etc.) instead of silently discarding data.

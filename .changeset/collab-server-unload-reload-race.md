---
'@ifc-lite/collab-server': patch
---

Fix an unload/reload race that could lose room updates. A room's final compaction on unload replaces the persisted log, so a fresh instance of the same room loaded and written to while that compaction was in flight could have its update wiped. `getOrCreate` now waits for an in-flight unload of the same room. `sweepIdle` re-checks each candidate before unloading it, so a room a peer joined meanwhile stays loaded. A destroyed room refuses new connections (`addConnection` returns `false`), and the join path retries into the reloaded room instead of registering a ghost peer. `unloadAll` also waits for unloads the idle sweep already started.

Each room now runs its appends and periodic compactions one at a time, and `destroy()` waits for them before its final compaction. Two compactions in flight could otherwise race on the same temp file, or an older periodic snapshot could land after a reload had appended.

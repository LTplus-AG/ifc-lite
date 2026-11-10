---
'@ifc-lite/collab-server': patch
---

Fix an unload/reload race that could lose room updates. A room's final compaction on unload replaces the persisted log, so a fresh instance of the same room loaded and written to while that compaction was in flight could have its update wiped. `getOrCreate` now waits for an in-flight unload of the same room. `sweepIdle` re-checks each candidate before unloading it, so a room a peer joined meanwhile stays loaded. A destroyed room refuses new connections (`addConnection` returns `false`), and the join path retries into the reloaded room instead of registering a ghost peer. `unloadAll` also waits for unloads the idle sweep already started.

Each room now has at most one persistence write in flight, and `destroy()` waits for it before its final compaction. Two compactions in flight could otherwise race on the same temp file, or an older periodic snapshot could land after a reload had appended. Updates that arrive while a write runs are merged (`Y.mergeUpdates`) into a single pending append, so a slow backend cannot build an unbounded queue. On unload that pending append is dropped, because the final compaction already contains it, and if the final compaction fails the full state is appended instead.

---
'@ifc-lite/collab-server': patch
---

Fix an unload/reload race that could lose room updates. A room's final compaction on unload replaces the persisted log, so a fresh instance of the same room loaded and written to while that compaction was in flight could have its update wiped. `getOrCreate` now waits for an in-flight unload of the same room. `sweepIdle` re-checks each candidate before unloading it, so a room a peer joined meanwhile stays loaded. A destroyed room refuses new connections (`addConnection` returns `false`), and the join path retries into the reloaded room instead of registering a ghost peer. `unloadAll` also waits for unloads the idle sweep already started.

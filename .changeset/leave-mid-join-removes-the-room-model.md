---
'@ifc-lite/viewer': patch
---

Remove the reconstructed `room:<id>` model when a collab session is left while
its join is still finishing.

The recipient join registers a real model record for the room and installs the
teardown that removes it only after `await reconstruct()` has returned. The
abandoned-join guard sits below that assignment and returned without running the
teardown, so a Leave landing in that window left the model in `models` — and the
doc `update` listener attached — until the next `stopCollab` (#3016).

The guard now runs the teardown this join installed before disposing the
session. It runs the join's OWN closure, never the module-level slot, because a
newer join may already own that slot by then and running its teardown would drop
the room model of the session the user is actually in.

The publish into that slot is now conditional on this join still being the live
one, which fixes the mirror-image leak the fix would otherwise have left open: a
stale continuation resuming after a newer join had already published its
teardown overwrote it, so the newer room's model was never removed on the next
Leave. Both checks read `collabRoomId` against this join's `roomId`, the same
granularity as every other re-check in `startCollab` — neither can tell a rejoin
of the same room from this join still being live.

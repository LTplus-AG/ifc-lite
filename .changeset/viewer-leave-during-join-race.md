---
"@ifc-lite/viewer": patch
---

Fix leaving a collaboration room mid-join silently putting the user back in it once the join finished.

`startCollab` re-checks `get().collabRoomId === roomId` after each of its own await points, from session creation through model reconstruction, so a `stopCollab()` landing in any of those windows is caught and the half-built session disposed. The final block — wiring the remote-apply and annotation-sync teardowns, then the closing `set({ collabSession: session, collabConnecting: false, ... })` — had no such check and ran unconditionally. `collabRoomId` is set synchronously at the top of `startCollab`, before any await, so `RoomPanel`'s "Leave" button is live while the join is still awaiting `session.whenSynced`: clicking it cleared `collabRoomId`/`collabSession`, and the suspended continuation then resumed and revived the session the user had just left, with remote-apply and annotation-inbound teardown closures installed that the next `stopCollab()` would not match to the session it disposes.

`startCollab` now applies the same `collabRoomId` guard before that final block, disposing the session and returning instead.

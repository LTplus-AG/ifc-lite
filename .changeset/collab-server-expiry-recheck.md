---
'@ifc-lite/collab-server': minor
---

`Principal.expiresAt` is now enforced, not just carried. It was documented in `auth.ts` as "checked again every 5 minutes per spec", populated from a room token's `exp` claim, and never read anywhere on any post-connect path (#3441): an established WebSocket session kept write access indefinitely after its credential's stated expiry, since `verifyRoomToken` only checks expiry at connect and nothing re-examined it afterward.

Two enforcement paths, covering different exposure:

- `Room`'s write-gate (`preCheckWriteFrame`) now denies a sync write-frame with reason `expired` once `Date.now()` passes `principal.expiresAt` (plus the same clock-skew tolerance `verifyRoomToken` applies at connect).
- A new periodic sweep, `Room.sweepExpiredPrincipals` / `RoomManager.sweepExpiredPrincipals`, closes any connection whose principal has expired — every 5 minutes by default, matching the documented interval — so read and presence access stop too, not only writes. It reuses the same close-and-let-`ws.on('close', ...)`-clean-up path as an explicit admin kick.

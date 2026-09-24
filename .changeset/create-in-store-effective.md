---
"@ifc-lite/create": patch
---

In-store authoring walks read the session's edited model (#5249). Auto Spaces no longer treats a wall deleted this session, or retyped into a non-divider class, as a room divider. Space Sketch dedup (`existingSpaceFootprintsByStorey`, now taking an optional overlay) counts a space created earlier in the session as existing, and no longer counts a deleted one. Duplicate (`resolveDuplicateSource`, now taking an optional `StoreEditor`) replays only the source's live association relationships, including ones created this session, and refuses a source deleted this session. `OverlayWallReader` gains optional `isDeleted` and `getTypeMutations`.

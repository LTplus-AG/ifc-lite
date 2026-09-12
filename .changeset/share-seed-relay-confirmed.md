---
"@ifc-lite/collab": minor
"@ifc-lite/viewer": patch
---

Sharing: the invite is withheld until the relay confirms it holds the model (#4446). The owner seed ends in a new `confirming` phase: `@ifc-lite/collab` gains `fetchRoomStateVector` (reads a room's state vector from the sync handshake of a throw-away connection), `stateVectorCovers` and `roomSocketUrl`, and `runOwnerSeed` reports `ready` only once the relay's state vector covers the owner's — a local transaction only proves the bytes are queued in the browser's socket, and a tab closed at that moment used to leave the room empty. Share dialog and Room panel show "Confirming the upload with the room server…" meanwhile; a relay that never confirms settles the seed as failed with an owner-facing message. The viewer also gains a per-browser `localStorage` override for the collab server URL (`ifc-lite:collab:server-url`), mirroring the existing enabled-flag override, so a built viewer can be pointed at a local relay without a rebuild.

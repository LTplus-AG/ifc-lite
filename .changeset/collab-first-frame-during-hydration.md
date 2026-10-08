---
"@ifc-lite/collab-server": patch
---

A client that sends its first frame while the room is still loading no longer loses it. y-websocket sends sync step 1 as soon as the socket opens; on a cold room the server attached its message listener only after authentication and the room's log read, so the frame was dropped and the client stayed unsynced. The listener is now attached first and frames are held (at most 64 frames and 1 MiB, then the socket closes with 1009 and the `rejects` metric counts reason `hydration-buffer`) until the peer is registered. A peer that disconnects during the load is also no longer registered as a ghost peer.

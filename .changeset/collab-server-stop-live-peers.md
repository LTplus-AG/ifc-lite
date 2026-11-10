---
'@ifc-lite/collab-server': patch
---

Fix `stop()` never resolving while a peer is connected. The `noServer` WebSocketServer's `close()` callback waits for every client to leave, and `stop()` awaited it before unloading rooms, which is the only thing that closes peer sockets. `stop()` now:

1. stops accepting connections without waiting;
2. calls the new `RoomManager.shutdown()`, which stops the idle sweep and latches the manager closed (from that moment every `getOrCreate` is refused, so a join still in setup cannot load a room that outlives the server) and then unloads every room, giving each its final compaction and closing its peers;
3. closes sockets that never reached a room with 1001, and terminates whatever has not closed after a bounded grace period.

`stop()` is idempotent. If a room fails to unload, the socket drain still runs and `stop()` then rejects. The entrypoint's access-control flush now runs on SIGTERM with peers attached.

`RoomManager.unloadAll()` still evicts every room and leaves the manager, including its idle sweep, serving; only `shutdown()` stops the sweep. When a room fails to unload, `unloadAll()` now lets every other room finish its final compaction first and logs each failure, then rejects with the first failure's original error, as before.

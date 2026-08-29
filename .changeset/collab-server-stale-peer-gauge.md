---
'@ifc-lite/collab-server': minor
---

Fix `/metrics` reporting a stale, permanent peer count for a room after it unloads.

`peersGauge` is keyed by `roomId`, an identifier the connecting peer picks (the websocket URL path). Every scrape re-`set` the gauge for each currently-loaded room, but nothing ever removed a series for a room that had since unloaded, so `collab_room_peers{room="<id>"}` kept reporting that room's last-known (non-zero) peer count forever, and the registry grew one label series per distinct room id that was loaded at the time of some scrape over the life of a long-running server rather than tracking only currently-loaded rooms. `MetricsRegistry`'s gauge now exposes `reset()`, and the `/metrics` handler resets `peersGauge` before repopulating it from the live room list on each scrape.

---
'@ifc-lite/collab-server': patch
---

`RoomManager.getOrCreate` now disposes a `Room` whose `loadFromDisk()` rejects, instead of leaking it.

The `Room` constructor already starts disposable resources — notably y-protocols'
`Awareness`, which self-starts a `setInterval` renewal/eviction timer — and wires
`doc`/`awareness` listeners, before `loadFromDisk()` runs. When `loadFromDisk()`
threw (corrupt persisted log, transient disk error), the room was never returned
to any caller, so nothing outside the closure could reach it to dispose those
handles. Every failed load leaked one `Awareness` timer for the life of the
process. Confirmed with `process.getActiveResourcesInfo()`: a live `Timeout`
survived a rejected `getOrCreate()` before this fix, and none does after it.

The reject path now tears the half-built room down (best-effort) before
rethrowing, so the promise still rejects exactly as before.

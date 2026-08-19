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

**Fixed in the same patch:** the disposal above must not call `Room.destroy()`,
because `destroy()` ends with a final `compact()` of the room's (empty or
partial) `doc` onto the persisted log. On the reject path `loadFromDisk()`
never applied anything to `doc` — that is what "reject" means here — so a
transient disk error (`EMFILE`, `ENOSPC`, an NFS blip) or a corrupt log would
have been turned into permanent data loss by the very cleanup meant to fix the
timer leak. Reproduced with a real OS-level `EMFILE` (fds exhausted via a
lowered `ulimit -n`, not a stubbed throw): a room with real persisted content,
a `load()` that fails once with a genuine `EMFILE`, and the descriptor
exhaustion clearing before cleanup ran — `Room.destroy()` compacted the empty
doc over the log, replacing real bytes with an empty Yjs update. The reject
path now calls a new `Room.disposeUnloaded()`, which does everything
`destroy()` does except the compaction, so nothing is ever persisted from a
doc that never finished loading.

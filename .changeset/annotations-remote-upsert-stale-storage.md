---
"@ifc-lite/viewer": patch
---

Fix `upsertRemoteAnnotation` leaving a stale pin behind in `localStorage` when a previously-local pin's id later arrives flagged `remote`.

`upsertRemoteAnnotation` only wrote to storage `if (!annotation.remote)`, on the assumption that a `remote`-flagged upsert never needs a write. That held for a fresh peer pin (never persisted, nothing to clean up) but not for an id that was persisted earlier while non-remote: skipping the write left the old local version sitting in storage, ready to resurrect on the next `loadFromStorage()` even though the in-memory map had already moved on. `saveToStorage` already filters its own output to non-remote entries, so the guard was redundant for the write-a-local-pin case and unsafe for the ownership-flip case — both `upsertRemoteAnnotation` and `removeRemoteAnnotation` now always call `saveToStorage`, letting it be the single source of truth for what belongs in storage.

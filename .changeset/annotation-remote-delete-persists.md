---
"@ifc-lite/viewer": patch
---

Fix a peer's deletion of one of your own annotation pins resurrecting on reload.

`removeRemoteAnnotation` — the path a collab room's incoming delete event drives — dropped the id from the in-memory map but never touched `localStorage`. If the pin was locally-authored (persisted on creation), its id stayed in the stored JSON; `loadFromStorage()` reads that JSON on the next mount and put the "deleted" pin right back.

Its two siblings already got this right: `removeAnnotation` (a local delete) and `upsertRemoteAnnotation` (a peer's edit of one of our pins arrives as non-remote and is persisted like any local edit) both call `saveToStorage`. `removeRemoteAnnotation` now mirrors `upsertRemoteAnnotation`'s condition — it persists the deletion when the pin being removed was not marked `remote` (i.e. it was ours and therefore already in storage), and skips the write for a purely-remote pin, which was never persisted in the first place.

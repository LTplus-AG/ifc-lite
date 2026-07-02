---
"@ifc-lite/collab-server": patch
---

fix(collab-server): merge persisted update frames instead of byte-concatenating them

Room logs store one Yjs update per `append`. Every persistence backend
(`Memory`, `File`, `Redis`, `S3`) returned the frames byte-concatenated, and
`loadFromDisk` fed that blob to `Y.applyUpdate`, which decodes only the first
update and silently ignores the rest — so every edit after the first frame was
lost on room reload (up to `compactEvery` updates between compactions). `load`
now combines frames with `Y.mergeUpdates`.

Also:
- `FilePersistence` room ids are encoded with `encodeURIComponent` (reversible,
  collision-free, traversal-safe) instead of a lossy `[^a-zA-Z0-9._-] -> _`
  replace that mapped distinct rooms (e.g. `a/b` and `a:b`) onto one log file.
  Safe ids (UUIDs, room codes) are unchanged, so existing logs keep their names.
- `JsonlFileAuditSink.append` no longer poisons its write chain: a single failed
  append previously left the shared promise rejected, so every subsequent append
  was skipped forever. Writes now run after the previous one settles regardless
  of outcome, while callers still observe their own error.

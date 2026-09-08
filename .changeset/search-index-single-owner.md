---
"@ifc-lite/viewer": patch
---

Fixed model search indexing so only one owner builds the Tier-1 index per model. Previously both `SearchInline` and `SearchModal` independently mounted `useSearchIndex`, which could create competing index builds or let a stale build's promise handlers overwrite a newer one; the hook now lives once on `ViewerLayout` for the model's lifetime and both search surfaces consume the same records. Unmounting an owner (including a React StrictMode remount) releases its claim instead of leaving a model's index stranded in a "building" state, and a superseded build can no longer clear a replacement's result.

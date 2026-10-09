---
"@ifc-lite/ids-authoring": minor
---

Three-way merge: `mergeDocuments(base, ours, theirs)` / `mergeOps` merge two revisions of a Studio document at the op level. One-sided changes merge automatically; overlapping field changes and delete-versus-edit become conflicts that keep the base until a side is chosen (`resolutions`). Order is settled per list with last-writer-wins and a diagnostic. The merged ops can be re-checked by the grounding gate. `conflictView` / `resolveConflict` form the framework-free view model for a conflict UI.

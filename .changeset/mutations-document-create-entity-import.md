---
"@ifc-lite/mutations": patch
---

Document that `MutablePropertyView.importMutations()` is not a full inverse of `exportMutations()` for overlay-created entities (#2044).

A `CREATE_ENTITY` record only carries the expressId in the mutation history, not the entity's type and attributes, so `importMutations()` cannot rebuild the entity from the record alone — it logs a `console.warn` and skips the record, dropping every other mutation recorded against that same id in the same batch too. This behaviour was already correct (fixed in #2045), but was undocumented on the public surface: neither the package README nor the `exportMutations`/`importMutations` JSDoc (which reaches the published `.d.ts`) said so. Both now state the asymmetry plainly and point at `restoreNewEntity()` as the companion path a caller must use to carry a created entity across before calling `importMutations()`. No runtime behaviour changes.

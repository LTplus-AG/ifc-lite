---
"@ifc-lite/mutations": minor
"@ifc-lite/viewer": patch
---

Undo and redo now work for creating or deleting a whole property set, and for whole quantity-set creation and quantity or quantity-set deletion (#5965). Each whole-set mutation records its set's overlay rows before and after the edit on the new `Mutation.setOverlay` field (typed `SetOverlaySnapshot`), and `MutablePropertyView.restoreSetOverlay` puts either side back exactly. Previously the viewer moved these entries between the undo and redo stacks without touching the view, so an undone set still reached the panel and "Export changes", and an undone deletion stayed deleted.

---
"@ifc-lite/mutations": patch
---

Seed the overlay express-id watermark above deferred property atoms, not just `entityIndex.byId`.

On huge files the parser defers high-cardinality property atoms out of `byId` into `deferredEntityIndex` (`deferPropertyAtomIndex`). `StoreEditor.computeMaxExistingId()` scanned only `byId`, so a deferred atom sitting above the primary-index maximum could have its express id reused for a newly created overlay entity. With the export fix now emitting deferred atoms, that collision would surface as two `#ID=` definitions in the STEP output. The watermark (and the post-construction "store grew" guard) now span `deferredEntityIndex` too. Surfaced in review of the #1110 export fix.

---
"@ifc-lite/clash": minor
"@ifc-lite/viewer": minor
---

Store and compare clash runs per coordination round. `clashSlotReviewKey(clash, { slotOf, ruleRevision })` qualifies each element by its federation slot and the rule's semantic revision (`clashRuleRevision`), returning `null` for a GlobalId repeated within a slot; `parseClashReviewKey` reads old and new keys. `buildClashRunDocument` produces a versioned, JSON-serialisable run (slot → sha256 manifest, rules with revisions, engine, settings, per-slot coverage, findings with slot-qualified keys and bounding boxes, the pairs it excluded), with `CLASH_RUN_DOCUMENT_JSON_SCHEMA` and `validateClashRunDocument`. `compareClashRunDocuments` sorts findings into added / persistent / no longer detected / not comparable (with reasons), separate from review status, and `carryForwardReviews` applies decisions to a new run and reports the ones it could not carry. The viewer's `ViewerHandle.onClashRunComplete` hands a host each finished run as a `browser-submitted` document; nothing changes without a registered listener.

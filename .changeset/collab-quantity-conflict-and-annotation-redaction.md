---
"@ifc-lite/collab": patch
---

Fix two gaps found while auditing files with no direct test coverage:

- `createConflictDetector` classified concurrent writes to a Pset property as a `pset-property` conflict but had no matching case for the structurally identical Qset (quantity) shape — concurrent quantity writes from two peers landed silently with no conflict event, a false negative. `classify()` now handles `ENTITY_KEY.QUANTITIES` the same way it handles `ENTITY_KEY.PSETS`, emitting a new `quantity` `ConflictKind`.
- `redactAuthorMeta` (the "anonymise this project" GDPR helper) blanked `createdBy`/`lastEditedBy` on every entity but never touched the `annotations` map, so a markup pin's `authorId`/`authorName` (real display name) survived redaction untouched. It now blanks both fields on every annotation alongside the existing entity-meta redaction; annotation `note` text and position are left as-is.

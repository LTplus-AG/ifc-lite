---
'@ifc-lite/export': patch
---

Fix named-attribute STEP export writing a quoted string over a REAL-typed slot that was previously `$`.

Setting a numeric georeferencing field for the first time — `IfcMapConversion.OrthogonalHeight`, `XAxisAbscissa`, `XAxisOrdinate`, `Scale`, or any other REAL-backed named attribute previously unset in the file — inferred the STEP output form from the token being replaced. All four fields are OPTIONAL in IFC4, so a real project's file legitimately has `$` there; with no numeric token to read, the fallback fell through to string quoting and wrote e.g. `'12345'` in a slot ISO 10303-21 requires to be the unquoted REAL literal `12345.` — a silently invalid file.

`applyAttributeMutations` (source-buffer named-attribute edits) and `applyOverlayEntityOverrides` (overlay-created entities) now resolve the slot's declared schema type first via `getRealTypedSlots`, the same schema-aware REAL detection positional attribute edits have used since #1839, and only fall back to token inference for slots the schema does not classify. This fixes every named-attribute mutation through a REAL-typed slot, not only `IfcMapConversion` — `IfcProjectedCRS` georeferencing edits and general per-entity attribute edits (`setAttribute`) share the same code path.

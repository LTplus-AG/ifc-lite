---
'@ifc-lite/export': patch
---

Fix `setAttribute` on a source-backed IFC2X3/IFC4X3 entity resolving its STEP positional slot against a fixed IFC4-pinned attribute order, writing the new value into a different, unrelated attribute of the record instead of the one named.

`applySourceLineMutations`'s named-attribute pass (`step-attribute-mutations.ts`) resolved a mutation's `attrName` to a positional slot via `getAttributeNamesAcrossSchemas`, which tries the parser's IFC4-pinned codegen registry first regardless of the entity's actual schema. An entity's attribute order can differ between IFC2X3, IFC4 and IFC4X3 for a shared attribute name — e.g. `IfcTask.Status` sits at slot 6 in IFC2X3, but IFC4 inserts `Identification`/`LongDescription` ahead of it, pushing `Status` to slot 7 — so editing `Status` on an IFC2X3 `IfcTask` silently overwrote `WorkMethod` instead, leaving `Status` itself unchanged and no error raised. This is the write-side counterpart of the read-side fix `subset-entity-reader.ts`'s `attrIndex`/`stepSourceSchema` already applied for `anonymize-scrub.ts` (#3309), and had been called out there as a known, unfixed pitfall on this exact function.

`applyAttributeMutations` now resolves each name through `attrIndex(entityType, attrName, stepSourceSchema(schemaVersion))` — the source entity's own bundled schema table first, falling back to the pinned-then-union resolver only for a type that schema's table doesn't know.

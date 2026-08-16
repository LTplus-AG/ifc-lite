---
"@ifc-lite/export": patch
---

Make the dead `if (!dataStore.source)` guards in `StepExporter`'s six line readers live, without changing an answer. `IfcDataStore.source` is a mandatory accessor — a model that kept no bytes carries `EMPTY_SOURCE_BYTES`, not `null` — so those guards never fired. They were also redundant where they sat: a zero-length range decodes to `''`, which fails every regex the readers below them run.

`getRelatedEntities`, `getRelatedPropertySet`, `getPropertySetName`, `getElementQuantityName` and `getPropertyIdsInSet` now share one `entityLineText` reader whose check is on the entity's BYTE RANGE rather than on `source`. Strictly equivalent, verified by mutation: swapping the range check back for the old guard leaves every test in the package passing.

Left as-is, verified neutral: the per-entity `byteLength === 0 || byteOffset < 0` skip in the source-iteration pass and the owner-history read already conjoin their own byte check, and `EntityExtractor` construction degrades safely.

A new `sourceless-store-export.test.ts` drives `StepExporter` from a store with no source bytes and pins both directions, with file-parsed controls alongside. (`sourceless-header-count.test.ts`, #2414, was the first such case in this package; this one covers the reader and closure paths it does not.)

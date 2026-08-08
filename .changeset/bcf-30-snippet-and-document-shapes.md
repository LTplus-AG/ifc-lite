---
"@ifc-lite/bcf": minor
---

Fix BCF 3.0 `BimSnippet` and `DocumentReference` being written and read in the BCF 2.1 shape, which made our 3.0 output schema-invalid and silently dropped or corrupted the equivalent fields when reading a spec-correct 3.0 file from another vendor's tool.

Three divergences between the two schema versions were unhandled (all per `buildingSMART/BCF-XML` `markup.xsd`):

- `BimSnippet`'s external flag is `isExternal` in 2.1 and `IsExternal` in 3.0. The reader only matched the lowercase spelling, so a spec-correct 3.0 file with `IsExternal="true"` read back as `isExternal: false` — a silent wrong value, not a parse failure. The writer emitted lowercase at version 3.0. The same rename is already handled for the `Header`/`<File>` attribute; this applies the identical treatment to `BimSnippet`.
- `DocumentReference` replaced 2.1's `<ReferencedDocument>` plus `isExternal` with a choice of `<DocumentGuid>` (a reference into `project.bcfp`'s Documents) or `<Url>`, dropping `isExternal` entirely. The reader required `<ReferencedDocument>` to be present, so every reference in a 3.0 file was dropped; the writer emitted the 2.1 shape regardless of version.
- 3.0 groups the entries under a single `<DocumentReferences>` container, while 2.1 repeats `<DocumentReference>` directly under `<Topic>`. The writer emitted the 2.1 containment at version 3.0.

`BCFDocumentReference` gains optional `documentGuid` and `url`, and `isExternal`/`referencedDocument` become optional since 3.0 has no equivalent — hence a minor rather than a patch, as reading either field now requires a presence check.

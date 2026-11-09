---
"@ifc-lite/create": minor
---

`copyBatchInStore` takes a `shape` option . With `shape: 'own'`, a copy of an element read from the file gets its own shape records, read from the file's STEP text, instead of sharing the source's `IfcProductDefinitionShape`, so the copy and its source can be edited apart. Representation contexts and representation maps stay shared. A shape over the copy bound (50,000 records) refuses the copy rather than falling back to sharing. The default, `'shared'`, is unchanged, so Duplicate and existing callers produce the same output and file size.

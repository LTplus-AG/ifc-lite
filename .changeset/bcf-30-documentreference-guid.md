---
'@ifc-lite/bcf': patch
'@ifc-lite/encoding': minor
'@ifc-lite/clash': patch
---

Write the `DocumentReference/@Guid` that BCF 3.0 requires.

2.1's markup.xsd leaves the attribute optional and 3.0's
`DocumentReferenceAttributes` marks it `use="required"`, so a 3.0 topic
carrying a document reference without one produced a `markup.bcf` that fails
validation, and a viewer that rejects markup.bcf drops the topic entirely. A
guid is now derived when the caller supplied none, and written back onto the
reference so the in-memory project matches the file. A caller-supplied guid is
kept, and BCF 2.1 output is unchanged.

The guid is a pure function of the topic, the document and the position, so two
exports of one unchanged project are byte-identical. `uuidFromSeed` moved from
`@ifc-lite/clash` to `@ifc-lite/encoding` to make that sharing possible without
a package cycle (`@ifc-lite/clash` depends on `@ifc-lite/bcf`); it is now
exported from `@ifc-lite/encoding`, and `@ifc-lite/clash` re-exports it from its
existing path, so no clash caller changes.

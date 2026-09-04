---
'@ifc-lite/bcf': patch
---

Write the `DocumentReference/@Guid` that BCF 3.0 requires.

2.1's markup.xsd leaves the attribute optional and 3.0's
`DocumentReferenceAttributes` marks it `use="required"`, so a 3.0 topic
carrying a document reference without one produced a `markup.bcf` that fails
validation, and a viewer that rejects markup.bcf drops the topic entirely. A
guid is now generated when the caller supplied none, the way a missing
`projectId` already is; a caller-supplied guid is kept, and BCF 2.1 output is
unchanged.

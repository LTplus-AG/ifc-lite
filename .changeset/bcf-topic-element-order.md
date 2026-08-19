---
"@ifc-lite/bcf": patch
---

Fix `markup.bcf`'s `<Topic>` children being written out of `xs:sequence` order.

buildingSMART's BCF `markup.xsd` `Topic` sequence — identical in release_2_1 and release_3_0 — is `Title, Priority, Index, Labels, CreationDate, CreationAuthor, ModifiedDate, ModifiedAuthor, DueDate, AssignedTo, Stage, Description, BimSnippet, ...`. The writer previously emitted `Description` right after `Title` (before `Priority`/`Index`/`Labels`/the creation and modification fields/`Stage`) and `Labels` after `Stage` (long after `Priority`/`Index`) — both schema-invalid regardless of content, since `xs:sequence` enforces element order. Confirmed against buildingSMART/BCF-XML's own release_3_0 conformance fixture (`Test Cases/v3.0/Visualization/Perspective camera`), whose `markup.bcf` places `Description` right before `BimSnippet`/`DocumentReferences`, matching the schema.

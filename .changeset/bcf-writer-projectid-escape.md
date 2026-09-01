---
'@ifc-lite/bcf': patch
---

Escape `BCFProject.projectId` when writing `project.bcfp`.

`writeProjectFile` interpolated `projectId` directly into the `<Project ProjectId="...">` attribute without XML-escaping, unlike every other free-text field the writer emits (Title, Description, Comment, Author, AssignedTo, Labels, Stage, DocumentReference names, and `project.bcfp`'s own `<Name>`). A `projectId` containing `"` broke the attribute's own quoting; a bare `&` or `<` made the whole `.bcfzip` non-well-formed XML, which a strict external reader (Solibri, BIMcollab, usBIM) rejects outright rather than opening the file.

`readBCF` now also unescapes `ProjectId` on the way back in, matching the write-side fix — otherwise a read-modify-write round trip on an escaped value would double-escape it (`&` -> `&amp;` -> `&amp;amp;`) on the next write.

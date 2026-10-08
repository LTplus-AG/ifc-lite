---
"@ifc-lite/ids-authoring": minor
---

Semantic diff for IDS documents: `diffDocuments(a, b)` pairs specifications and facets with the matcher shared with re-identification (node id within one Studio document; identifier, name and signature, then similarity otherwise) and reports added, removed, moved and changed nodes field by field. `changelog` / `changelogMarkdown` render one plain-language sentence per change in English, German or French. `diffToOps` turns a diff into the primitive ops that rebuild the second document from the first.

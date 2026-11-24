---
"@ifc-lite/bcf": patch
---

Write BCF 3.0 `Guid` attributes (Topic, Comment, Viewpoint, RelatedTopic, DocumentReference, viewpoint file) in lowercase hex. BCF 3.0 `shared-types.xsd` accepts only lowercase, so a project read from a 2.1 archive with uppercase GUIDs wrote a 3.0 archive that failed schema validation. BCF 2.1 output is unchanged.

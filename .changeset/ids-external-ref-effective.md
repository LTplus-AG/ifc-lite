---
"@ifc-lite/ids": patch
---

IDS classification facets on a live, edited model read `IfcExternalReferenceRelationship` classifications of non-rooted resources (materials, profiles) from the session's effective model (#5249). A relationship deleted this session no longer classifies its material, and one created this session does. Created classification references in the chain are read from their authored payload. Pass the model's mutation view as `createDataAccessor`'s third argument, as before.

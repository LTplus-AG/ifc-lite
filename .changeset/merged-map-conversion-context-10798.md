---
"@ifc-lite/export": patch
---

A merged STEP export keeps a later model's representation context separate when its georeference differs from the one already on the shared context: a different map conversion or rigid operation, target CRS, or map unit. It used to unify the two contexts whenever their coordinate frames matched, so one frame carried two georeferences. Models where only one is georeferenced still share one context, as do models whose operations and CRSs are equal in every attribute. A context kept apart, for a different georeference or coordinate frame, is now listed in the merged IfcProject's RepresentationContexts; before, it belonged to no project.

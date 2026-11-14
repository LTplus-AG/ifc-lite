---
"@ifc-lite/create": minor
"@ifc-lite/sdk": minor
---

Add missing schema-aware structural builder variants, reusable loads and eccentric connection conditions, with lazy SDK/viewer authoring.

This is an additive API change. Existing valid IFC inputs remain supported; the new refusals reject malformed, non-finite, or schema-invalid inputs rather than removing supported exports or behavior. Distribution validation applies to the new curve-action API.

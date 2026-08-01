---
"@ifc-lite/lens": patch
---

Fix the classification "System" picker on auto-color lenses being a no-op. `selectClassificationRef` fell back to an entity's first classification whenever none of its classifications matched the selected system, so every classified entity was grouped and colored regardless of which system was chosen. It now returns no match (the entity ghosts, like an unclassified one) when the selected system isn't among the entity's classifications, actually filtering by system as the picker implies. Closes #1923.

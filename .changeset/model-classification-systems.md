---
"@ifc-lite/parser": minor
---

Add `extractClassificationSystemsOnDemand(store)`, a cheap and exact per-model listing of the distinct `IfcClassification` system names present (e.g. Uniclass, OmniClass, a national system) — walks only the `IfcClassification` entities via the `byType` index, not a per-element scan. Used by the viewer's model-level info panel to show all classification systems used in a model, not just the first.

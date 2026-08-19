---
"@ifc-lite/viewer": patch
---

Fix the BIM ↔ scan deviation heatmap (`DeviationPanel`) staying "computed" — slider, legend and colours all left showing — after removing a federated model whose geometry the heatmap was built against.

`DeviationComputer.compute` builds its BVH from every triangle currently in the scene, not just one model's, so removing any federated model invalidates a prior compute. `pointCloudDeviationComputed` is the flag that gates both the panel's "Recompute" vs. "Compute deviation" label and its auto-recompute effect (`!computed && ...`), so leaving it `true` meant nothing ever re-triggered a rebuild — the panel kept presenting a heatmap computed against a triangle set that no longer existed until the user happened to click Recompute themselves.

`removeModel` already tears down this same "references geometry that just changed" class of staleness for the clash focus, the IDS validation report and the compare result; the deviation flag was the one sibling it left out. `clearAllModels` gets the same fix for the full-teardown path.

---
"@ifc-lite/viewer": patch
---

Fix an active lens keeping a removed model's colors and clearing them onto a new model that reuses its global-id range.

`useLens`'s evaluation effect only depended on `[activeLensId, activeLens]`; it read `models` / `ifcDataStore` from `getState()` without subscribing to either, so removing a model or calling `clearAllModels` never triggered a re-evaluation. `lensColorMap`, `lensHiddenIds`, `lensRuleCounts`, `lensRuleEntityIds`, and `lensAppliedColors` kept referencing the departed model's entities. This wasn't just dangling: `clearAllModels` also resets the federation registry's offset counter, so the next model loaded can be handed the exact global-id range those stale entries still point at — a lens rule that matched the old model's entity keeps "matching" whatever unrelated entity now occupies that id, and `useCompareOverlay`'s teardown resends `lensAppliedColors` to the renderer verbatim.

The effect now also depends on a lightweight fingerprint of the loaded model id set (add/remove only, not in-place field patches like loading progress or visibility toggles), and clears the lens-derived state when the model set empties out — mirroring what already happens on lens deactivation.

---
"@ifc-lite/lens": major
"@ifc-lite/sdk": major
---

Manual `LensRule` now selects entities with `groups: FilterGroup[]` from `@ifc-lite/rules`. `evaluateLens` receives a map of selected global IDs per rule, and the old `matchesCriteria` evaluator is removed. Use `evaluateFilterGroups` or `evaluateFilterGroupsFederated` to select IDs, then pass them to `evaluateLens` for ordered color and visibility actions. The viewer migrates saved v1 criteria on local load and JSON import; conditions without an exact mapping stay inert and visible with a warning until replaced. The SDK re-exports the changed Lens types, so its major version follows the same migration.

---
"@ifc-lite/rules": minor
"@ifc-lite/lists": minor
"@ifc-lite/viewer": patch
---

Add a `listCondition` filter rule (#6190). It carries a saved Lists value predicate (zone assignment and the zone volume modes, exact spatial levels, quantity and material presence, model file name, Lists attributes, inherited properties) inside a Rules `FilterGroup`, so it can combine with other rules under AND or OR. The Lists engine evaluates it. Each evaluated model supplies `EvaluatorModel.listConditions`, and `@ifc-lite/lists` exports `listConditionMatcher(provider)` to build one. A run whose rules hold a `listCondition` throws before reading any element when a model has no matcher, instead of matching nothing. Rule-set files reject the kind. The viewer's list runner attaches the matcher to every model it runs.

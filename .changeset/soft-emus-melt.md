---
"@ifc-lite/lens": major
---

Require the third `matchedByRule` argument when calling `evaluateLens`. Manual
Lens rules now apply actions only to global IDs selected by the shared
`@ifc-lite/rules` FilterGroup evaluator. The former `LensCriteria` fallback
could disagree with saved group filters and color the wrong entities.

Consumers must evaluate each rule's `FilterGroup[]`, translate model-local IDs
to global IDs, and pass a map from rule ID to the selected global-ID set.
Missing map entries match nothing. `evaluateAutoColorLens` is unchanged.

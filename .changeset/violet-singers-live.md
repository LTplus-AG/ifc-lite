---
"@ifc-lite/lens": major
---

Remove the retired `matchesCriteria` export and its standalone v1 evaluator.
It was no longer called by `evaluateLens`, so keeping a second matcher invited
future drift from the shared `@ifc-lite/rules` FilterGroup evaluator.

Consumers that called `matchesCriteria` should express the condition as a
`FilterGroup[]` and evaluate it with `@ifc-lite/rules`. Pass the selected global
IDs by rule ID to `evaluateLens` when applying colors or visibility.

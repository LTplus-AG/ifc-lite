---
"@ifc-lite/rules": minor
---

Fix a failing rule reporting `passRate: 100` next to `status: 'fail'` (#5177). An `aggregate` rule now counts every applicable element that belongs to a failing group (plus any element excluded for an absent or non-numeric subject) as failed, each element once, so `failedCount`, `passedCount` and `passRate` match the verdict. A failure that no applicable element carries, such as an unmet or exceeded `cardinality` or an empty `universe` group, now reports `passRate: 0` instead of 100. This is the rule `@ifc-lite/ids` already applies (#5212). The bump is `minor` because anything that reads these numbers will now see different values.

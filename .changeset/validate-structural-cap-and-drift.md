---
"@ifc-lite/cli": patch
---

`ifc-lite validate` caps `structural-unconnected-member` rows at 50 with a count of the rest, as it does for unlinked elements, and now runs the `structural-axis-drift` rule.

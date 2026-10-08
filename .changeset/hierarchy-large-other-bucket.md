---
"@ifc-lite/viewer": patch
---

Keep the hierarchy panel rendering on very large models. Expanding the "Other" bucket in By Class or By Type with more than roughly 120k geometry-less elements, a spatial node with that many direct children, or an authored type/group relation of that size no longer throws `RangeError: Maximum call stack size exceeded`; rows are appended one at a time instead of being spread as call arguments.

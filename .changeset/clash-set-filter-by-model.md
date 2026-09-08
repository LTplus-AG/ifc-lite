---
"@ifc-lite/viewer": minor
---

Added a Model filter rule to the clash advanced-filter editor, so a clash set can be scoped to one or more loaded models in a federation instead of always evaluating every model. The rule is populated from the current session's loaded model names and stores a filename-qualified source fingerprint, so a saved rule stays bound to the intended model after reopening the same files (which get fresh runtime model IDs) — evaluation still resolves current runtime IDs for selection and clash routing. Federated evaluation also skips scanning models excluded by a Model rule.

---
"@ifc-lite/mutations": minor
---

Expose `MutablePropertyView.getQuantityMutation` for current quantity overrides, including explicit unit removal. This read is independent of append-only mutation history and lets downstream unit readers retain source inheritance without restoring a unit that was explicitly removed.

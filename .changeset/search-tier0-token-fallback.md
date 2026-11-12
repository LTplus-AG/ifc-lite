---
"@ifc-lite/viewer": patch
---

Search returns the same results before and after a model's tier-1 index is ready: the Tier-0 scan applies tier-1's match rule (token-prefix candidates, the substring ladder, the short-needle sweep) through one shared function.

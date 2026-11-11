---
"@ifc-lite/viewer": patch
---

Search answers multi-word queries the same before and after the tier-1 index is ready: the Tier-0 scan applies tier-1's token fallback (every query word a prefix of a word in the element's name, type, description or object type).

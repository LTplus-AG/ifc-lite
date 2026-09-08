---
"@ifc-lite/cli": patch
---

Fix `extract-entities` pulling extra entities into an extraction when a product's Name or Description contains a `#`-prefixed number that happens to match a real expressId in the file (e.g. `'Chair pairs with #71'`). `forwardClosure` now walks each record's reference closure the same string-aware way `subset-relations.ts` already does for relation members, so an id mentioned only inside free text is no longer treated as a reference.

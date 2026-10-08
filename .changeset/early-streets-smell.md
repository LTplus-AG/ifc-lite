---
"@ifc-lite/mutations": minor
---

Bind authored entity creation provenance to the current NewEntity record. Native creation uses the same token as its CREATE_ENTITY mutation; original record clones and undo preserve it, while tokenless replacement/recovery cannot borrow stale history as proof of identity.

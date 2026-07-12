---
"@ifc-lite/mutations": minor
---

`changeSetToOps` serializes entity retypes (`UPDATE_ENTITY_TYPE` → a `bsi::ifc::class` opinion, with `PredefinedType` on the core-attribute channel) instead of silently dropping them, and reports unrepresentable mutation types in a new `skipped` result field so callers can warn instead of under-publishing.

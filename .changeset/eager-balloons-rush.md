---
"@ifc-lite/lists": major
"@ifc-lite/sdk": patch
---

Replace `ListDefinition.conditions` with required Rules `groups: FilterGroup[]`.
Viewer lists now evaluate those groups through `@ifc-lite/rules`, including
federated models and live property edits. Saved v1 lists and imported
`.list.json` files migrate on read; predicates without an equivalent Rules
form remain active and visible in `unreadableConditions`.

Consumers constructing a definition should replace flat `conditions` with
`groups`. The synchronous provider-only `executeList` accepts already-filtered
snapshots through `expressIdsByModel`; it rejects nonempty groups so it cannot
silently return extra rows. For a v1 predicate that has no Rules equivalent,
pass it as `legacyConditions` to that provider-only path.

The SDK's `bim.list.execute()` keeps its optional `conditions` contract by
passing an empty Rules group set and translating supplied conditions into
provider-only predicates for the updated Lists engine.

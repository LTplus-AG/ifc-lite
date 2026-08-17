---
'@ifc-lite/clash': patch
'@ifc-lite/viewer': patch
---

Fix clash element identity for federated models past the first.

The viewer's loader shifts every `mesh.expressId` into the federated global id
space in place, while `IfcDataStore` keeps local express ids. `elementsFromStep`
used `mesh.expressId` to address the store anyway, so for any model with a
non-zero `idOffset` every lookup missed: `key` fell back to the synthetic
`expressid:N`, `tag` read `Unknown`, name and storey came back empty, and
`buildStepExclusions` found no relationships — so the void / host / assembly
exclusions silently stopped excluding. `ref` was wrong in the other direction,
with `federation.toGlobalId` adding the offset a second time.

`elementsFromStep` now takes `meshIdOffset`: the shift the host has already
applied to `mesh.expressId`. It subtracts that back out before touching the
store, so the store is addressed locally and the federation offset is applied
exactly once. Callers that pass local meshes (CLI, MCP, the playground) leave it
at its `0` default and are unaffected.

No clash result is persisted, and both the review state and the user exclusion
rules are keyed on the durable element key rather than on `ref`, so nothing
stored has to be migrated. Review status that a pre-fix session saved against a
federated model past the first was keyed on the synthetic `expressid:N`
fallback, though, so it no longer matches and those clashes come back as `open`.

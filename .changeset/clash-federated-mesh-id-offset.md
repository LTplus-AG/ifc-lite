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
exclusions silently stopped excluding, and a door in the opening it fills was
reported as a hard clash. `ref` was wrong in the other direction, with
`federation.toGlobalId` adding the offset a second time.

`elementsFromStep` now takes `meshIdOffset`: the shift the host has already
applied to `mesh.expressId`. It subtracts that back out before touching the
store, so the store is addressed locally and the federation offset is applied
exactly once. Callers that pass local meshes (CLI, MCP, the playground) leave it
at its `0` default and are unaffected — it stays optional deliberately, since
`elementsFromStep` is published API and requiring it would break every external
caller. To keep a forgotten offset from being silent in any host, the adapter
now also warns once when every element in a model resolves to an empty GlobalId
*and the store does hold GlobalIds* — the signature of exactly this wiring
mistake. A model whose store has none (a GLB import, whose store carries
geometry and no IFC entities) is left alone: there, every element missing is the
normal state, not a defect.

The synthetic key an element without a GlobalId falls back to is now scoped to
its model — `expressid:<encoded modelId>:<expressId>` rather than
`expressid:<expressId>`. Express ids are only unique within a model, and review
state and user element-pair exclusions are keyed on the element key alone
(deliberately, so they survive a reload), so in a federation the unqualified
form made two models' elements one identity: a review status or an exclusion set
on one model's element silently covered another model's element. Two federated
GLB models produced ONE review key where there should have been two.

Migration: elements that have a GlobalId — nearly all of them, and every one
this fix restores — are unaffected; only the fallback changes shape. A review
status or an element-pair exclusion a previous session stored against the old
`expressid:N` string stops matching: the clash comes back as `open`, the
exclusion rule stays listed but suppresses nothing. Nothing is mis-applied, and
nothing else reads the string. In the viewer that fallback is per-load anyway
(the model id is a per-load uuid), which is the honest position for an element
that carries no durable identity of its own. Review status a pre-fix session
saved against a federated model past the first was likewise keyed on the old
fallback and no longer matches.

---
'@ifc-lite/data': minor
'@ifc-lite/query': patch
'@ifc-lite/cache': patch
---

fix(query): make `whereProperty` actually filter STEP-parsed models

`EntityQuery.whereProperty()` returned `[]` for every `.ifc` (STEP) model, for
any property-set name, silently — no error, no warning. `applyPropertyFilters`
only consulted `store.properties.findByProperty`, but a STEP parse deliberately
leaves the columnar property/quantity tables empty and routes reads through the
on-demand maps (issue #577), so that lookup could only ever return nothing. The
read path (`EntityNode.property`, `QueryResultEntity.getProperty`) resolved the
same data correctly, so a model that plainly carried the property still filtered
to nothing. #577 / #578 fixed this class on the read path and left the filter
path behind; this is that other half.

`whereProperty` now picks a strategy per store. When the property table reports
an explicit zero row count it resolves the surviving candidates through
`store.getProperties` / `store.getQuantities`, the same accessors the read path
uses; otherwise it answers off the table's name indices as before. Only an
explicit zero selects the fallback — a duck-typed store whose table omits the
optional `count` keeps the indexed path, because every store written before
`count` existed implements `findByProperty` for real. The fallback is
candidate-scoped and each entity is resolved at most once across all filters.
Nothing is materialised onto `store.properties`, so IDS keeps reading the richer
on-demand property shape.

Quantity sets are folded into the same call on every store, making the
documented `whereProperty('Qto_WallBaseQuantities', 'NetSideArea', '>', 10)`
form work; previously a `Qto_` filter matched nothing on any path.

Matching is ANY-match: an entity passes when any property of that name, in any
set of that name, satisfies the operator. That is what
`PropertyTable.findByProperty` already did, so the two strategies agree with
each other. It deliberately differs from the single-value read path, which
returns the first match — the two disagree only for an entity carrying the same
property twice, and that divergence is pinned by a test.

`@ifc-lite/data` gains two additive optional interface members and one new
export: `QuantityTable.findByQuantity` (the quantity mirror of `findByProperty`,
answered off the quantity-name index), `count` on `IfcStoreBase`'s property and
quantity tables, and `comparePropertyValues` — the definition of property-filter
comparison semantics shared by the store-level property tables (same-type only,
`null` never matches, `==` aliases `=`). `@ifc-lite/cache` and the viewer's
server-converted store now use
`comparePropertyValues` instead of local copies: the cache copy had no boolean
branch, so a cache-restored `findByProperty('IsExternal', '=', true)` silently
returned `[]`, and the server copy ignored the operator entirely and compared
with `===`, so `'>' 60` answered `= 60`.

**Cost.** Filtering a STEP model is now real work where it used to be an instant
wrong answer. The shape of that work: the filter resolves property sets **per
candidate**, so cost is proportional to how many entities reach the filter, not
to how many carry the property. Scope with `ofType(...)` / `onStorey(...)` before
`whereProperty(...)` — an unscoped `query.all().whereProperty(...)` resolves
every entity in the model. The guide and the package README now say so.

This per-candidate path covers more than a fresh `.ifc` parse. A cache written
from a STEP parse serialises the empty property table verbatim, so a
cache-restored `.ifc` model reports `count === 0` and takes the same fallback;
the viewer's server-converted store reports `count: 0` too. What decides the
path is the store rather than the file format: a store carrying table rows is
answered from the index, and one reporting no rows resolves per candidate.

Those indexed stores are deliberately kept off the per-candidate path: folding
quantities by resolving every candidate would have made a `Qto_` filter cost
them per candidate as well, so the quantity side goes through the new
`findByQuantity` name index instead. Where an indexed store's cost moves at all
it is because the query is answered rather than silently returning nothing — a
`Qto_` filter that used to match zero entities now matches the real set.

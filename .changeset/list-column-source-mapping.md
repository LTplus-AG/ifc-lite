---
'@ifc-lite/sdk': patch
---

Fix `bim.list.execute()` returning `null` for every column, every row, always.

The SDK's `ListColumn` is documented as `{ header, source }` where `source`
is a free-form string — `'name'`, `'type'`, `'globalId'`, or a
`'PsetName.PropName'` path (`packages/sdk/src/namespaces/list.ts`). `@ifc-lite/lists`'
`executeList` (`packages/lists/src/engine.ts:566`) switches on `col.source`
against its own structured enum instead — `'attribute' | 'property' |
'quantity' | 'material' | 'classification' | 'spatial' | 'model' | 'zone'` —
and falls through to `default: values[i] = null` for anything else
(`packages/lists/src/engine.ts:608`). `execute()` forwarded SDK columns
straight through unchanged, so every SDK-shaped column matched none of the
library's cases: every cell in every `bim.list.execute()` result came back
`null`, for every caller, on every call.

Separately, the library's `ListDefinition.conditions` is a required array —
`resolveSourceSet` reads `conditions.length` unconditionally
(`packages/lists/src/engine.ts:270`) — while the SDK documents its own
`conditions` as optional. Omitting it (a documented-valid call) threw
`Cannot read properties of undefined (reading 'length')` instead of running
unfiltered. And a *supplied* condition fared no better: the SDK's
`ListCondition` (`{ psetName, propName, operator: '=' | '!=' | ... }`) has no
`source` discriminator and spells its operators differently from the
library's `PropertyCondition` (`'equals' | 'notEquals' | ...`), so it matched
none of `getConditionValue`'s cases (`engine.ts:382`) and — because a `null`
actual value makes `matchesCondition` return `false` unconditionally
(`engine.ts:308`) — every entity failed every condition: a filtered call
silently came back with an **empty** table rather than an error.

`ListNamespace.execute()` now translates each SDK column into the library's
`ColumnDefinition` shape (`'name'`/`'type'`/`'globalId'` map to the
`'attribute'` source; a `'Pset.Prop'` path maps to `'property'`, or
`'quantity'` when the set name has the `Qto_` prefix `bim.bsdd` already uses
to distinguish the two), translates each supplied condition into the
library's `PropertyCondition` shape the same way (plus mapping the operator
spelling), and defaults `conditions` to `[]` when omitted.

Downstream-visible: `bim.list.execute()` now returns the actual property/
attribute/quantity values it always claimed to, instead of an all-`null`
table; a `ListDefinition` without `conditions` no longer throws; and a
supplied `conditions` filter now actually filters instead of silently
returning zero rows.

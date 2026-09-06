---
'@ifc-lite/ids': minor
'@ifc-lite/mutations': minor
---

`createDataAccessor` (`@ifc-lite/ids/bridge`) now accepts an optional
`propertyOverlay` resolver: `(expressId) => PropertyOverride[] | undefined`.
When provided, `getPropertyValue` and `getPropertySets` apply the returned
overrides (set/delete) on top of the store's own property projection before
returning results; every other accessor method is unaffected, and omitting
the parameter reproduces the exact previous behaviour.

This lets a caller with in-memory property edits that have not yet been
exported (e.g. the viewer applying an IDS-driven correction through its
mutation overlay) re-run IDS validation and see those edits reflected,
instead of only ever validating the last parsed/exported bytes.

No breaking change: the new parameter is optional and every existing call
site is unaffected.

Fixes a defect in the viewer's overlay resolver (not part of this package,
but depends on the API below): after an undo, IDS re-validation kept
reporting a corrected property as still overridden, because the resolver
read `MutablePropertyView.getMutationsForEntity()` — the append-only
`mutationHistory`, which undo does not pop (it re-applies the inverse
mutation with `skipHistory=true`). `MutablePropertyView` gains
`getPropertyMutation(entityId, psetName, propName)`, returning the live
overlay's current `PropertyMutation` for that key (or `undefined` when the
key carries no override right now) — the same live-overlay source
`hasChanges()` / `getModifiedEntityCount()` already use instead of history,
now exposed so a caller projecting the overlay onto an external base can
tell "no override", "override is a DELETE", and "override is a SET to
null" apart.

Also fixes a case-sensitivity mismatch in `resolveEffectivePropertySets`
(the overlay merge behind `createDataAccessor`'s `propertyOverlay`
parameter above): `getPropertyValue`/`getPropertySets` already match
pset/property names case-insensitively (to tolerate real-world IFC files
whose Pset/property names don't match the canonical casing), but the
overlay merge matched exact-case only. When an override's target name
differed only in case from the entity's actual (non-conformant) base
property name, the merge appended the override as a SEPARATE,
differently-cased property instead of replacing the existing one — and
the case-insensitive read then returned the untouched base entry first,
since it comes earlier in iteration order. A correction could read back
as applied (its own write-then-verify check reads the exact key it just
wrote) yet stay permanently invisible to a re-run of IDS validation
through this same accessor. The merge now matches case-insensitively too,
consistent with the read path it feeds.

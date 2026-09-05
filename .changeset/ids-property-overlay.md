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

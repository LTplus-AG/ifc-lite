---
'@ifc-lite/ids': minor
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

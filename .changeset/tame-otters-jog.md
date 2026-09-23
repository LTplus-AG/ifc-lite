---
'@ifc-lite/diff': minor
---

`diffModels` now classifies a re-parented element (moved to a different spatial container — storey, space, or building) as `modified` with a `'container'` change kind, instead of `unchanged`. Previously `EntityFingerprint.container` was computed but never read by the key-matched classification, so an `IfcRelContainedInSpatialStructure`/`IfcRelAggregates` reassignment with no accompanying attribute or geometry change was invisible to Compare. The comparison only fires when both revisions resolved a non-empty container; an unresolved container on either side is not treated as a change.

---
"@ifc-lite/create": minor
---

Add `storeyPlanFrame`, `toStoreyLocal` and `fromStoreyLocal`: the storey's whole
`IfcLocalPlacement` chain (storey axis ∘ building ∘ site ∘ …) composed into one
planar rigid motion in the model's world frame, in metres, and the two folds
between that frame and the storey-local one.

`addSpaceToStore` anchors the outer curve to the storey's own placement, so
every coordinate it is handed is read back through that chain. The in-package
producers are storey-local for exactly that reason; a producer that already
works in world coordinates now has a supported way to divide the chain out
before authoring, and to fold `existingSpaceFootprintsByStorey`'s storey-local
rings the other way for a comparison in its own frame.

`storeyPlanFrame` returns `null` rather than approximating when the storey
itself will not read, when a link in the chain will not read, or when any link's
`Axis` tips out of plan — a tilted chain has no planar inverse. A storey with no
`ObjectPlacement` at all gets the identity: `ObjectPlacement` is OPTIONAL on
`IfcProduct`, and a product without one carries no transform.

The placement-frame primitives these share with `extractWallSegmentsForStorey`
move to an internal `placement-frame` module so both sides compose and invert
the chain through one implementation. No existing export changes.

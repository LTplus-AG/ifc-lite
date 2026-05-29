---
"@ifc-lite/wasm": minor
---

Render IFC4x3 `IfcGridPlacement` so products laid out on a structural grid
land on their grid-axis intersections instead of stacking at world origin
(issue #883).

The placement resolver dispatched only on `IfcLocalPlacement` and
`IfcLinearPlacement` — every other placement type fell through to identity.
The reporter's `ifcgrid.ifc` placed 25 `IfcColumn`s via
`IfcGridPlacement → IfcVirtualGridIntersection`, so they all collapsed onto
the same spot instead of spreading across the grid.

This change:

- Recognises `IfcGridPlacement` in the placement resolver. `PlacementRelTo`
  (the grid's own placement) composes exactly like `IfcLocalPlacement`;
  `PlacementLocation (IfcVirtualGridIntersection)` is resolved by reading the
  two referenced `IfcGridAxis` curves, intersecting them in the grid plane,
  applying the per-axis lateral `OffsetDistances` (each axis shifted along its
  left normal) and the optional elevation, then composing `parent * local`.
- Implements full `IfcGridPlacementDirectionSelect` coverage for
  `PlacementRefDirection`: an `IfcDirection` sets local +X directly; an
  `IfcVirtualGridIntersection` points local +X from the placement location to
  that second intersection; null / unresolved inherits the grid orientation.

Out of scope (documented in code):

- Grid axes are treated as straight lines (chord of the first→last curve
  sample); curved axes would need arc-length sampling.

Regression coverage:

- `grid_placement_tests` in `rust/geometry/src/router/transforms.rs` — inline
  unit tests that assert the resolved transform directly: the axis-intersection
  origin, both `PlacementRefDirection` variants, the `OffsetDistances`
  perpendicular shift + elevation, and `PlacementRelTo` composition. No
  committed fixture (per AGENTS.md §9); the unit tests are self-contained.

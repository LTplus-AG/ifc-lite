# @ifc-lite/server-bin

## 1.15.0

### Minor Changes

- [#887](https://github.com/LTplus-AG/ifc-lite/pull/887) [`175f8e3`](https://github.com/LTplus-AG/ifc-lite/commit/175f8e3ed93acba35f2efcb57993dd137ff7a241) Thanks [@louistrue](https://github.com/louistrue)! - Render IFC4x3 `IfcGridPlacement` so products laid out on a structural grid
  land on their grid-axis intersections instead of stacking at world origin
  (issue [#883](https://github.com/LTplus-AG/ifc-lite/issues/883)).

  The fix is in the shared `ifc-lite-geometry` Rust crate, so it ships on both
  surfaces that compile it: the WebAssembly build (`@ifc-lite/wasm`) and the
  native server binary downloaded by `@ifc-lite/server-bin` (pinned to its own
  package version, so it needs the bump to pull a rebuilt binary). The desktop
  app (Tauri) and the Docker server image compile the same crate and pick the
  fix up through their own build pipelines.

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

## 1.14.4

### Patch Changes

- [#494](https://github.com/louistrue/ifc-lite/pull/494) [`ec0d3a0`](https://github.com/louistrue/ifc-lite/commit/ec0d3a0e4c7f9eaeb26ab0a724fd76d955e52ac5) Thanks [@louistrue](https://github.com/louistrue)! - Remove recursive package `prebuild` hooks and run TypeScript via `pnpm exec` so workspace builds resolve correctly on Windows.

## 1.14.3

### Patch Changes

- [#330](https://github.com/louistrue/ifc-lite/pull/330) [`07851b2`](https://github.com/louistrue/ifc-lite/commit/07851b2161b4cfcaa2dfc1b0f31a6fcc2db99e45) Thanks [@louistrue](https://github.com/louistrue)! - Remove the unused `@ifc-lite/parser` runtime dependency from `@ifc-lite/mutations`, switch `@ifc-lite/server-bin` postinstall to a safe ESM dynamic import, and refresh the published `@ifc-lite/wasm` bindings and binary so the npm package stays in sync with the current Rust sources.

## 1.14.2

## 1.14.1

## 1.14.0

## 1.13.0

## 1.12.0

## 1.11.3

## 1.11.1

## 1.11.0

## 1.10.0

## 1.9.0

## 1.8.0

## 1.7.0

## 1.2.1

### Patch Changes

- Version sync with @ifc-lite packages

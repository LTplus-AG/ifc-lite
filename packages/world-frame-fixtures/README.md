# @ifc-lite/world-frame-fixtures

Private (unpublished) test fixture corpus for the world-frame defect class:
consumers that read raw `positions` as world coordinates (ignoring the
per-element RTC `MeshData.origin`, the wasm-path default), and tolerances
sized from the max |coordinate| over all three axes but compared against a
distance along one plane normal (#2598, #2600, #2529).

Four placements of the same element:

| Case | Positions | Origin | Catches |
| --- | --- | --- | --- |
| `at-origin` | world, near origin | none | counter-case: blanket tolerance changes |
| `far-baked` | world, 10 km out in X (f32-baked) | none | max-over-axes tolerances tested along Y/Z |
| `local-frame` | element-local | world centre | raw-positions-as-world consumers |
| `far-local-frame` | element-local | centre + 10 km X | both composed |

The far offset lives on ONE axis (default X). Test behaviour along a
DIFFERENT axis: an offset on the tested axis coincidentally equals the
correct projection and proves nothing. The expected tolerance shape is the
normal-projected ULP sum `sum |n_i| * ulp32(extent_i)`
(`normalProjectedNoiseBound`), the formulation
`packages/drawing-2d/src/section-cutter.ts` documents (PR #2622).

Carriers (do not force one type to serve both axes of the corpus):

- `MeshData` (`asMeshData`, `translateWorld`) carries BOTH axes: RTC origin
  cases and large-coordinate cases. The viewer compare instance (#2529) is
  deliberately NOT wired here yet: PR #2659 fixes it and ships its own
  origin-folding tests with hand-built meshes in
  `apps/viewer/src/lib/compare/geometrySummary.test.ts`. Migrating those
  onto this corpus once both branches land is the named follow-up.
- World-only mesh types (clash contact `Mesh`, via `bakedWorldPositions`)
  carry ONLY the large-coordinate axis — they have no origin field by
  contract. Wired into `packages/clash/src/contact/world-frame.test.ts`
  (#2600, fix PR #2661).
- The Rust kernel mirror lives in
  `rust/geometry/src/world_frame_fixture.rs` (baked cases only, same
  reasoning), wired into `csg/world_frame_tests.rs` and
  `clash_solid_world_frame_tests.rs`.

Cases that pin a live defect assert the CORRECT behaviour inside a
known-failing wrapper (`it.fails`, `assertKnownDefect`, `#[should_panic]`)
that itself fails the moment the fix lands, forcing the unmark.

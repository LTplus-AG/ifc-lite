# Alignment sampling evidence (#6600)

The installed native Python abi3 wheel was run against the catalogued
`tests/models/issues/844_terrain_and_alignment.ifc`, exported by **TUM Open
Infra Platform 2017** (its `IfcApplication` records this authoring tool).
SHA-256: `f6124170e390ed865120985dbd0e6fd38d5c9caae97dd41082031d3246e6a096`.
Fetch it with `pnpm fixtures`; the regression tests skip with that instruction
when the catalogued file is absent.

Actual `alignment_axes(content, spacing_m=5)` output: five distinct axes,
zero diagnostics, with their real `GlobalId` attributes retained. `Name` is
null in this authored file; the human labels are in `Description`, which is
not misrepresented as `Name`.

| ExpressId | Geometric horizontal length (m) | Samples including endpoints |
| --- | ---: | ---: |
| 39 | 94.247876042 | 20 |
| 59 | 419.699973558 | 85 |
| 114 | 56.548515502 | 13 |
| 134 | 91.662133789 | 20 |
| 161 | 114.772107698 | 24 |

`issue_6600_real_circle_matches_analytic_heading_and_radius_oracle` independently
integrates the first CCW circular arc (#43) using its authored start heading,
radius and a 10 m geometric distance. It checks world XY coordinates against
that analytic result rather than another call to the alignment evaluator.
The companion infrastructure test checks all five identities, finite unit
3D tangents and endpoint inclusion. Synthetic invariants cover millimetres,
rotated/tilted placements, large absolute f64 coordinates, a nonzero authored
chainage, an IFC4x3 graded circular path and reported tessellation approximation,
invalid references, cyclic/long placement chains and output/work/diagnostic bounds.

The public distance starts at the physical start in the alignment-local XY
plane; it is not authored chainage, projected-world XY distance or 3D arc length.
The strict API refuses declared invalid/unsupported placements and incomplete
curves; the existing permissive mesh/renderer alignment evaluator remains on
its original policy. Existing WASM renderer line density and output are unchanged.

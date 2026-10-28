<!-- SPDX-License-Identifier: MPL-2.0 -->
# M4 ordering correction (#7955)

Authority: the orchestrator's round-2 ruling and subsequent clarification in
the implementation conversation on 2026-10-28. The clarification explicitly
directs reuse of exact's scalar offset/sense ordering, and IFC's transported
Axis normal for curved geometry. Exact's known planar approximation for curved
walls is report-only. Authored band products independently verify the result;
they do not define it. A disagreement with them must stop implementation.

Exact evidence: `rust/geometry/src/material_layer_index.rs:41-45` defines
Axis2 as object +Y; `router/layers/planes.rs:27-48` places interfaces at
`d = offset * scale + sense * C`, with normal `rotation * axis * sense`;
`router/layers/slice.rs:63-81` takes the negative side first and leaves the
positive side as the remainder. These paths are relative to `rust/geometry/src`.
`router/layers/stages.rs:54-89` remains the eligibility and thin-layer authority.

For a directed XY circular Axis, positive Axis2 is its left normal: inward
for CCW (`sigma=+1`), outward for CW (`sigma=-1`). Thus
`q = sigma * (R * scale - rho)` and `w = sense * (q - offset * scale)`.
Solving `w=C` gives `rho = R*scale - sigma*offset*scale - sigma*sense*C`.
The first band is `w<C0`; the last is `w>C_last`.

With R=10 m, offset=0, C0=0.1 m, C1=0.3 m:

| sigma | sense | interface radii (m) | first side |
|---|---|---|---|
| +1 | +1 | 9.9, 9.7 | rho > 9.9 |
| +1 | -1 | 10.1, 10.3 | rho < 10.1 |
| -1 | +1 | 10.1, 10.3 | rho < 10.1 |
| -1 | -1 | 9.9, 9.7 | rho > 9.9 |

This corrects the unconditional inside-first cylindrical cutter table in
M4 section 3.3: exchange the first/last unbounded regions when sigma*sense>0.
For straight axes, sigma does not affect exact's fixed object-axis convention:
positive sense takes y<offset+C first; negative takes y>offset-C first.

For f-a-curved #55, sigma=+1 and sense=-1 imply w=rho-10 and bands
[10,10.1], [10.1,10.3], [10.3,10.6]. Independent products #122/#188/#254
author these annular sectors with their own opening cuts. For inner/outer
radii a,b their hand integral is
`3*pi*(b*b-a*a)/4 - 2*(F(b)-F(a))`, where
`F(r)=0.5*sqrt(r*r-0.25)+r*r*asin(0.5/r)`.
The height is 3 m; the centered 1 m wide door removes 2 m of height.
The real-SDK acceptance test compares capped band volumes with this integral
and with those independently authored products, then validates assembly closure.

Implementation deviation: CUT-0 has no `Select::Axis`; the canonical
`Select::Where` representation selector uses the Axis identifier instead.


The synthetic f-g fixture was independently reviewed by Opus on 2026-10-28
(two rounds). IfcOpenShell 0.8.3 parsed all 310 IFC4 entities, found no EXPRESS
issues, and preserved every entity type, reference and scalar in a write/read
roundtrip. The review corrected the future top-clip flag and added inward
CCW/POSITIVE #13055 (radii 9.9 and 9.7, first outside). Hand-derived fixture
quantities are asserted in `m4_oracle.rs`; SDK behavior is asserted separately.
The plane-clipped case remains unsupported until M5 composition lands.

Cap tests are a private sibling `layer_caps_tests.rs` unit suite to avoid
exposing presentation internals solely for integration tests. Native/browser
band parity reuses the existing staged M3 reference file with additive M4 keys;
no workflow is edited. Viewer rendering uses the existing double-sided mesh
pipelines (`packages/renderer/src/pipeline.ts:254`, `:316`, `:374`, `:441`).

The far-offset rotated fixture #2027 also exposes an existing exact f32 storage
defect. Its local rectangle is 2 m by 0.6 m, extruded 3 m: 3.6 m³. After
rounding its rotated XY corners to exact storage and subtracting the placement
(2600000,100000), the corners are (-0.5,-1.28125), (1.25,-0.28125),
(1,0.2421875), (-0.75,-0.7578125). Shoelace area is 1.166015625 m²,
so exact volume is 3.498046875 m³ (2.83203125% low). The real-SDK run
measures retained volume 3.6000000002622174 m³. The independent source oracle
therefore applies CUT-0's existing source-over-proven-exact-defect rule; no
tolerance is changed. A layered product still has one source instance, even
when its presentation contains multiple bands.

Native/browser qualification exposed a separate SDK triangulation ambiguity.
Replaying identical native wire requests into the actual WASM SDK produced the
same 466 vertices (maximum coordinate difference 6.6e-15 m) and 928 triangles
for #55's last capped band, but one warped quad on radius 10.3 used the opposite
diagonal. Its capped volumes were 14.169965548346143 and 14.16996229702047 m³,
a relative difference 2.2945191091677772e-7, failing the unchanged 1e-9 parity
gate. This is not an IFC ordering disagreement with the authored products.

The SDK emits the differing triangles inside `SmApiTessellate`, before the
adapter's polygon triangulation. The initial single-quad correction therefore
did not fix the replay and has been removed. M4 instead normalizes an interior
edge of two triangles only when they share a source face, form a strictly
convex noncoplanar quad, and the other diagonal is strictly shorter and absent
from the mesh. Each flip preserves all four directed boundary edges, vertex
bits, triangle count and source IDs; normals are recomputed from the new
triangles. Coplanar, concave, boundary and cross-source-face pairs are unchanged.
The walk has a linear work budget and fails closed on exhaustion. No SDK source,
frame or tolerance changes. Hand-derived invariants cover either starting
diagonal, cyclic starts, reversed winding, a concave pair and the captured cap.
Actual native/browser qualification remains required; these invariants alone
are not a parity result.

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
`router/layers/stages.rs:49-84` remains the eligibility and thin-layer authority.

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

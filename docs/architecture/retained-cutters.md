<!-- SPDX-License-Identifier: MPL-2.0 -->
# Retained cutter foundation (CUT-0, #7955)

The disabled retained path owns derived finite prisms separately from captured
IFC source recipes. `RetainedPrism` uses metre coordinates, a proper rigid
cutter-to-host frame, an ordered outer loop followed by holes, and a positive-Z
extrusion direction. `GeometryDocument::add_retained_prism` admits the same
wire-format-1 request on native and browser runtimes. It grants no product
publication authority. Halfspace dispatch still refuses plane, boxed and
polygonally bounded halfspaces until their feature slices are qualified.

The frozen segment interface is **Line | Arc | Circle**. This intentionally
extends M5-CHAINED-CLIPS §4.0.1 and §9, following the **Round 2 CUT-0 orchestrator
message of 2026-10-27**: M6 needs partial circular arcs for `IfcArcIndex`.
Arc uses the existing kind 3: centre xyz, normal xyz, x-axis xyz, radius, start
angle and signed sweep, all little-endian f64 after kind/reserved u32 words.
It is neither a three-point arc nor a new wire version. Prisms supply +Z and +X
as their local circular basis; winding normalization can reverse the sweep.

Bounds belong to a retained value's evaluation frame. Lines use endpoints;
arcs use full supporting-circle boxes; positive-weight rational disk sweeps
use their control hull expanded by radius. Difference and Intersection retain
the left bound. Union maps the right corners into the left frame. Placement
keeps bounds local; an affine bake maps every corner into the baked frame.
Computed endpoints round outward to their adjacent representable f64 value;
this is arithmetic enclosure, not an acceptance tolerance or changed wire data.
Unknown bounds stay unknown. Finite halfspace cutters use the specified 1 cm /
5% diagonal padding. `halfspace_box` also takes the halfspace source id so its
new Source definition preserves attribution.

`oracle::sections` reads extrusion definitions independently, clips exact
line/arc Green integrals at section heights, and integrates with adaptive
8-point Gauss–Legendre quadrature. Work exhaustion returns `None`. The relative
convergence threshold is the preregistered 1e-13. Analytic hand cases include
circular sectors, segments, holes and oblique extrusions.

Universe fragments live in `tests/fixtures/cli-retained/universe.d/*.txt`;
coverage rows live in exactly one base or per-slice TSV. Native blessing writes
each model back to its owner; Node parity reads all fragments. Feature oracle
checks own separate modules and report through `src_oracle` and per-family
maxima. The workflow uses `tests/m*` path triggers because the repository's CI
path checker rejects bracket classes; the Cargo test selector remains
`--test 'm[0-9]*'`. The broader path trigger only increases validation coverage.

The **2026-10-27 CUT-0 Round 3 orchestrator message** also changes the exact
comparison's authority, a documented deviation from M1's unconditional linear
gate: retained passing the independent source-volume oracle while exact fails
that same source value at the exact gate's limit classifies the product's exact
comparison as report-only `exact_defect`. The summary records all three
deviations. Every retained-vs-source check remains mandatory, all tolerance
values remain frozen, and there are no product allowlists. Missing source
oracles and retained source failures leave the exact gate unchanged. See the
[comparison contract](https://github.com/LTplus-AG/ifc-lite/blob/main/rust/retained-native/README.md) for the report fields.

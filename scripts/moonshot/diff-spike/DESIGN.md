# M3 differentiability spike (bet B2.4) - design, results, verdict

Status: **spike gate PASS** (both binary criteria met; see "Verdict" for the
honest scope of what passed).

This is the Phase 2 spike for moonshot M3 (differentiable buildings) from
`docs/vision/moonshots-tech.md` / `docs/vision/moonshots-execution-plan.md`.
The gate is binary: (a) analytic gradients of quantities/carbon with respect
to design parameters match central finite differences to 1e-6 relative on
95% of a randomized battery, and (b) one 20+ parameter optimization
converges to a valid state accepted by the kernel. Kill criterion: no
battery pass, no moonshot. Flagship objective (confirmed): embodied carbon
= sum over elements of material volume times a per-material carbon factor.

## 1. What was built

Five self-contained scripts (no new dependencies, ASCII only), importing
already-built `dist/` output of sibling packages by path (same pattern as
`scripts/moonshot/g0-certificate-demo.mjs`):

- `dual.mjs` - vector forward-mode autodiff over dual numbers. One
  evaluation on duals yields the value plus the exact analytic gradient
  with respect to all 24 parameters. `min`/`max` are exact (branch on
  value), making the differentiated path piecewise smooth exactly where
  the modelled CSG clipping is.
- `carbon-model.mjs` - the parametric building: a 3-storey rectangular
  building with 24 continuous design parameters (footprint, three storey
  heights, wall/slab/roof/partition thicknesses, window and door sizes,
  sill, column/beam sections, glazing and door-leaf thicknesses, footing
  dimensions). 74 elements: 12 exterior walls, 3 partitions, 3 slabs,
  1 roof, 12 columns, 6 beams, 4 footings, 29 windows, 4 doors. Element
  volumes are closed form; wall opening subtraction uses exact clipped
  overlap (`w * (min(sill + h, H) - sill) * t`, hinged at 0), which is
  the same piecewise structure the kernel's void cut produces. Embodied
  carbon uses fixed illustrative factors (kgCO2e/m3): concrete 315,
  brick 250, gypsum 120, glass 3300, timber 130.
- `build-ifc.mjs` - materializes any design vector as a real IFC4 model
  via `@ifc-lite/create` (walls with full-size `IfcOpeningElement` cuts,
  hosted `IfcWindow`/`IfcDoor` fills inset 2 mm inside their openings,
  materials assigned). Returns an expressId-to-parametric-key mapping.
- `kernel-check.mjs` - parametric-vs-kernel quantity validation: builds
  the IFC at seeded random buildable points, runs the real wasm geometry
  pipeline (`GeometryProcessor`, the same path the viewer and clash CLI
  use, CSG void cuts included), computes per-element mesh volumes by the
  divergence theorem, compares against the closed-form volumes.
- `battery.mjs` - the gate (a) battery.
- `optimize.mjs` - the gate (b) optimization plus the kernel validity
  projection (`GeometryProcessor` meshing, `ifc-lite validate`,
  `ifc-lite clash --mode hard`).

Reproduce:

```
node scripts/moonshot/diff-spike/battery.mjs 1000
node scripts/moonshot/diff-spike/kernel-check.mjs 8
node scripts/moonshot/diff-spike/optimize.mjs --out /tmp/diff-spike-out
```

## 2. Gate (a): the gradient battery

Protocol (seeded with mulberry32, fully deterministic):

- 1,000 random points drawn uniformly from the full 24-dimensional
  parameter box, seed 42. The full box deliberately includes regions
  where the opening-clip `min`/`max` branches switch (windows taller
  than the wall band), i.e. the piecewise seams of the CSG path.
- Two scalar outputs tested at every point: embodied carbon (kgCO2e)
  and total net volume (m3).
- Central differences per component: `fd_i = (f(x + h e_i) - f(x - h e_i)) / (2 h)`
  with `h_i = 1e-5 * max(1, |x_i|)` (near-optimal for central FD in
  doubles: truncation O(h^2) ~ 1e-10 relative, cancellation
  O(eps |f| / h) ~ 1e-9 relative at f ~ 1e5).
- Exact metric: `relErr = |ad - fd| / max(|ad|, |fd|, 1e-6)`, tolerance
  1e-6. A point passes only if all 24 components of BOTH outputs pass
  (48 comparisons per point).

Result: **977/1000 points pass (97.7%) >= 95% - gate (a) PASS.**
Robustness: seed 7 gives 97.7%, seed 2026 gives 98.3%.

The 23 failing points were inspected individually and every one is a
finite-difference precision artifact, not an autodiff error:

- 22/23 fail on the `sill` component with `ad = 0` exactly. When no
  window clips against the wall top, moving the sill translates openings
  vertically and provably changes no volume; the analytic zero is
  correct. The FD side returns cancellation noise of ~1e-9..1.5e-6
  absolute (double-precision ULP of f ~ 1e5 kgCO2e divided by 2h), which
  the strict 1e-6 floor does not absorb. The analytic side is exact;
  the reference is what wobbles.
- 1/23 (carbon/wwL, relErr 1.0e-4) is the same cancellation noise
  (~2.3e-6 absolute) on a small-magnitude gradient component (0.022).

No point failed because the analytic gradient was wrong, and no point
failed at a clip seam in this draw (seams are measure-zero; a point
landing within h of one would honestly fail FD, which the protocol
accepts as part of the 5% budget).

## 3. Parametric-vs-kernel quantity deviation

`kernel-check.mjs`, 8 seeded buildable points, 74 elements each, all
meshed by the real pipeline with 0 CSG failures and openings cut:

- mean aggregate relative deviation (sum of per-element absolute
  deviations over total volume): **4.6e-7**
- worst single-element relative deviation across all points: **9.1e-6**

At the optimization optimum: worst element 1.1e-6, kernel-derived carbon
73450.9 vs parametric 73450.9 kgCO2e (**relative deviation 2.7e-8**).
The residual is float32 mesh quantization (the pipeline emits f32
vertex buffers), not a formula divergence: the closed-form quantities
are exact for these extrusion + rectangular-void shapes.

## 4. Gate (b): the optimization

Minimize embodied carbon over all 24 parameters subject to:
headroom >= 2.5 m per storey; total floor area >= 600 m2; window area
per storey >= 12% of floor area (daylight); windows must fit inside the
wall band; column section >= structural tributary proxy; beam depth >=
span/12; slab/roof thickness >= span proxies; door egress width >= 0.95 m;
box bounds on every parameter.

Method: quadratic penalty with geometric mu ramp (10 -> 1e7), projected
gradient descent with Armijo backtracking inside each mu level, analytic
gradients from the dual path (the battery-validated code). Deterministic,
starts from the box centre.

Result: carbon **177.1 t -> 73.45 t (-58.5%)** in 63 s. The optimum is
economically sensible: every thickness at its lower bound, storey heights
at the headroom-driven bound, footprint shrunk to exactly the 600 m2
programme, windows sized to exactly the daylight requirement, column and
beam sections on their structural constraints. Four constraints active
(floor-area, daylight-s0, column-section, beam-depth); the worst
remaining violation is 4.8e-5 m2 on the 600 m2 floor-area constraint
(8e-8 relative - the expected asymptotic bias of a finite-mu quadratic
penalty; an augmented Lagrangian would drive it to zero but was not
needed for the gate).

Kernel validity projection at the optimum:

- Meshing: all 74 elements meshed, **0 CSG failures**, all 33 openings cut.
- `ifc-lite validate`: **0 errors** (1 warning: no authored quantity
  sets, which is expected - quantities live in the parametric model;
  authoring Qto sets from it is trivial follow-up work).
- `ifc-lite clash --mode hard`: **0 real hard clashes.** 21 findings
  remain, every one a designed face-to-face contact (walls seated on
  slabs, columns under slabs, door leaves on the floor) with penetration
  <= 7.4e-6 m, i.e. inside the clash package's own published contact
  band (`TOUCHING_EPSILON = 1e-4` in `packages/clash/src/analysis.ts`).
  f32 meshes make coincident faces cross by microns; the depth-based
  classification is the package's own `isTouching` semantics.
  One caveat found on the way: for A-inside-B contact pairs the engine
  reports `distance` as the AABB signed gap, which overstates "depth"
  for contained fills - eliminated structurally by insetting fills 2 mm
  inside their openings, which is also the physically honest geometry
  (frame gap).

Gate (b) **PASS**.

## 5. Honest limits (what this spike does NOT show)

1. **The gradient path is the parametric closed form, not the kernel.**
   Gradients flow through hand-derived volume formulas that the kernel
   verifiably reproduces to ~1e-6 (f32 floor) on this element family.
   Full M3 requires adjoints through the actual geometry pipeline
   (profiles -> extrusion -> placement -> CSG), where the formulas are
   not hand-derivable for arbitrary inputs.
2. **Element coverage is the rectangular-extrusion family**: walls with
   rectangular through-openings, slabs, columns, beams, footings, flat
   roofs, box fills. No curved profiles, no boolean chains beyond
   host-minus-openings, no sloped roofs, no stairs. For these shapes the
   parametric formulas are exact, which is precisely why the spike is
   informative but bounded.
3. **Topology is fixed across the parameter box** (element counts,
   window counts, connectivity). Real design optimization eventually
   changes topology (add/remove a window), which is combinatorial, not
   differentiable - out of scope for M3's continuous claim.
4. **The carbon factors are illustrative constants.** Swapping in real
   EPD data changes numbers, not derivatives (linear in volumes).
5. **The validity projection is check-after-step, not project-onto-
   manifold.** The optimum happened to be kernel-valid because the
   constraint set encodes buildability; a full M3 projection operator
   (snap an infeasible iterate back to a valid building) is future work
   and the hard research object.
6. **Piecewise seams are real.** At clip boundaries the objective is
   C0 but not C1; the battery's few near-seam failures are the honest
   signature. Full-kernel autodiff will have many more such seams
   (CSG topology changes); subgradient or smoothing strategies will be
   needed.

## 6. What full M3 would require

- Adjoints through the real quantity path: differentiate mesh-derived
  quantities (divergence-theorem volume is a smooth function of vertex
  positions; vertex positions are piecewise-smooth functions of
  parameters through the extrusion/placement/CSG chain). The CSG cut
  positions vertices as intersections of parameter-dependent planes, so
  each combinatorial cell admits exact adjoints; the cell structure
  changes at seams. A tape through `rust/geometry` (or a dual-number
  scalar type in the mesher) is the natural next experiment.
- The projection operator: after a gradient step, run the exact kernel
  as acceptance oracle and, on rejection, solve the nearest-valid
  problem (M1 certificates make the accepted state verifiable).
- Performance: this spike evaluates the parametric path in ~30 us;
  per-step kernel projection at interactive rates is the M6 dependency
  the execution plan already names.

## 7. Verdict

- Gate (a): **PASS** - 97.7% >= 95% at 1e-6 relative (metric documented
  in section 2), 1,000 seeded points, 24 parameters, carbon + total
  volume, failures forensically attributed to FD precision, not AD.
- Gate (b): **PASS** - 24-parameter carbon minimization converged
  (-58.5%) to a state the kernel accepts: meshes clean (0 CSG failures),
  validate 0 errors, 0 hard clashes beyond the package's own contact
  band, and kernel-recomputed carbon within 2.7e-8 of the value the
  optimizer descended on.

The M3 spike gate is met on its stated terms. The result de-risks the
"gradients of quantities/carbon w.r.t. parameters of created elements"
claim and sharpens where the real research risk lives: adjoints through
the kernel's own CSG path and the validity projection, not the
differentiation of quantities itself.

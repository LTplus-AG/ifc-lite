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

## 8. B3.3: proof-carrying optimization (Phase 3 flagship)

Phase 3 fuses this spike with the M1 provenance machinery
(`packages/provenance`, node-hash-v0): the optimization trajectory itself
becomes a verifiable artifact. Three new scripts extend the ones above
(nothing in the mathematics changed; `optimize.mjs` gained observation
hooks, a scenario parameter and an extracted `endpointChecks`, all
default-compatible):

- `trajectory.mjs` - state commitments and the certificate chain. Every
  ACCEPTED optimizer step is committed as a small Merkle DAG: a
  `DesignParameters` property-set (24 exact f64 bit patterns), a
  `DerivedQuantities` property-set (carbon, total volume, per-material
  volumes, max constraint violation - all RE-DERIVED from the parameters,
  never copied from the optimizer), and an element root binding both. A
  step record chains `{prevRoot, newRoot, parameterDelta, carbon/merit
  before+after, gradientNormBefore, stepSize, backtracks}` and carries a
  real `@ifc-lite/provenance` v0 certificate (reads = previous state's
  nodes, writes = new state's nodes, claim = scalar-delta on
  `EmbodiedCarbon`). mu ramps are explicit chain records.
- `optimize-certified.mjs` - runs the unchanged optimizer under a named
  scenario, records the trajectory, builds the chain, then grounds the
  endpoint: builds the real IFC, runs the kernel checks (meshing +
  quantity comparison, `ifc-lite validate`, `ifc-lite clash`), and binds
  the kernel-measured numbers plus the IFC hash into a final endpoint
  certificate whose root commits BOTH the final design state and the
  kernel validation.
- `verify-trajectory.mjs` - the independent verifier. Input: the chain
  JSON (start parameters live in its header) and nothing else. It
  re-derives everything instead of trusting the optimizer: per step it
  re-evaluates merit/carbon/gradient at the previous state (bitwise f64
  equality), REPLAYS the Armijo line search (every recorded backtrack
  trial must fail the acceptance test, the accepted trial must pass and
  must reproduce the recorded iterate bit for bit - so a step verifies
  only if it IS the projected-gradient step the published algorithm
  produces, not an arbitrary descent move), checks monotone merit
  descent, recommits the state DAG and checks chain linkage, and runs
  `verifyCertificate` against a resolver seeded only with the verifier's
  own re-derived payloads. At the endpoint it rebuilds the IFC from the
  final parameters, pins it to the committed canonical hash, re-runs the
  wasm kernel and compares the re-measured carbon/deviations to the bound
  values; `--recheck-cli` additionally re-runs validate and clash.
- `tamper-test.mjs` - adversarial battery, see below.

Reproduce (IFC artifacts and chains go to a working directory):

```
node scripts/moonshot/diff-spike/optimize-certified.mjs --scenario baseline --out /tmp/b33/baseline
node scripts/moonshot/diff-spike/optimize-certified.mjs --scenario strict   --out /tmp/b33/strict
node scripts/moonshot/diff-spike/verify-trajectory.mjs /tmp/b33/baseline/trajectory-chain-v2.json --recheck-cli
node scripts/moonshot/diff-spike/verify-trajectory.mjs /tmp/b33/strict/trajectory-chain-v2.json
node scripts/moonshot/diff-spike/tamper-test.mjs /tmp/b33/baseline/trajectory-chain-v2.json --full
```

(The certified run now writes the checkpointed v2 chain by default -
`--emit-v1` additionally writes the original one-certificate-per-step
chain; see "Chain format v2" below. The v1 numbers in the table above are
unchanged history.)

### Protocol notes

- **Kernel identity pins.** Certificates carry `kernelVersion`
  (`@ifc-lite/wasm@x + @ifc-lite/geometry@y`) and `trustRoot` = SHA-256 of
  the actual `ifc-lite_bg.wasm` binary. A verifier on a different kernel
  build fails fast instead of comparing incomparable numbers.
- **Bitwise determinism is the backbone.** The whole parametric path is
  deterministic f64 arithmetic, so the verifier demands exact equality on
  merit, objective, gradient norm and every replayed iterate. Node-hash-v0
  hashes numbers as f64 bit patterns, so a state root pins the design to
  the bit. Two tolerances are documented exceptions: the endpoint kernel
  re-measurement (1e-9 relative; mesh iteration order inside the pipeline
  is not contractually stable - both runs here reproduced bit-identically
  anyway) and the provenance package's own 1e-9 scalar-claim tolerance.
- **Canonical IFC hash.** `IfcCreator` output embeds random GlobalIds and
  two header timestamps a rebuild cannot reproduce; `canonicalIfc()`
  strips exactly those (verified: two same-parameter builds differ ONLY
  there), and the endpoint commits the canonical hash (re-derivable) plus
  the raw file hash (artifact label only).

### Results

Two scenarios, both certified and independently verified end to end:

| | baseline | strict |
|---|---|---|
| programme | >= 600 m2, 12% daylight, 2.5 m headroom | >= 720 m2, 15% daylight, 2.7 m headroom |
| carbon | 177.10 t -> 73.45 t (-58.5%) | 177.10 t -> 86.02 t (-51.4%) |
| accepted steps / records | 22,000 / 22,010 | 24,000 / 24,011 |
| optimize + chain build | 70.2 s + 2.6 s | 74.6 s + 2.9 s |
| chain size | 46.2 MB | 50.8 MB |
| independent verification | 69.9 s (incl. validate+clash recheck) | 81.2 s |
| kernel re-measured carbon | 73450.9 kgCO2e, rel dev 0.0 (bound) / 2.7e-8 (parametric) | 86016.1 kgCO2e, rel dev 0.0 (bound) / 9.7e-8 (parametric) |
| endpoint validity | 0 CSG failures, validate 0 errors, 0 real hard clashes | same |

Verification cost is ~3.1-3.4 ms per step (dominated by the dual-number
merit re-evaluations of the line-search replay, ~0.2 ms of it certificate
hashing), i.e. roughly the same order as the optimization itself - the
verifier re-runs the accepted mathematics once, plus every failed
backtrack trial.

Tamper battery (each mutation on a fresh copy of the real baseline chain,
mid-chain where applicable): a flipped parameter (delta kept consistent,
as a lazy forger would) is caught as `step-not-reproducible`; a faked
objective (certificate claim adjusted to match) as
`objective-after-mismatch`; a swapped prevRoot as
`chain-linkage-broken`; a forged newRoot as `state-root-mismatch`; a
tampered bound kernel number as `kernel-pset-hash-mismatch`; and the hard
case - faked kernel numbers with ALL hashes and the endpoint certificate
honestly recomputed - is caught by the kernel re-measurement as
`kernel-carbon-mismatch`. The untampered control verifies.

### What the chain proves - and what it does NOT

Proves, to a verifier trusting only the model/algorithm source and its
own kernel build:

1. **Trajectory integrity.** The published start state leads to the
   endpoint through exactly this sequence of states; every state's
   quantities are the true closed-form quantities of its parameters;
   every step is the projected-gradient/Armijo step the published
   algorithm produces (including the failed backtrack trials); merit
   descent is monotone within each mu level; mu follows the declared
   schedule.
2. **Endpoint validity.** The final parameters materialize to an IFC
   whose canonical bytes are hash-committed, which the real kernel meshes
   with 0 CSG failures, whose kernel-measured quantities match the
   certified quantities, and which passes validate and hard-clash checks.

Does NOT prove:

1. **Global optimality.** Nothing certifies the endpoint is the best
   design - only that this descent trajectory is genuine and its endpoint
   is kernel-valid.
2. **Authorship.** v0 certificates are unsigned (signing is reserved for
   M4). An adversary who actually RUNS the published algorithm from some
   start point can produce a different, equally valid chain; what they
   cannot do is fake a chain without doing the descent work, or alter one
   step of an existing chain undetected.
3. **The scenario's merit.** The constraint set is committed in the chain
   header, but whether 12% daylight is the RIGHT requirement is a human
   question outside the proof.
4. **Kernel correctness.** The endpoint grounding trusts the pinned wasm
   build (trustRoot); certifying the kernel itself is M1's
   predicate-sign manifest territory, not this chain's.
5. **CLI outcome re-derivation is optional.** validate/clash outcomes are
   hash-bound always, but only re-measured under `--recheck-cli`; without
   it a (pointless) consistent forgery of those two summaries would pass.

The compounding thesis this demonstrates: B2.4's gradients gave fast
descent, M1's hashes gave verifiable state, and their composition gives
something neither had alone - an optimization result a third party can
audit step by step without re-running the optimizer's search or trusting
its author.

### Chain format v2: checkpointed segments

The v1 chain is one certificate per accepted step: correct, but 22,000+
records and 46-51 MB per run, which makes storage and verification I/O the
bottleneck artifact-side (verification itself is compute-bound at ~2-3 ms
per step - the Armijo replay, not the reading, is the cost). Format v2
(`trajectory-cert-v2`, built by `chainToV2()` in `trajectory.mjs`,
emitted by default by `optimize-certified.mjs`) batches N consecutive
steps (default 256, `--segment N`) into a segment record whose
`@ifc-lite/provenance` v0 certificate commits:

- the segment's start and end state DAG roots (certificate reads = the
  entry state's nodes, writes = the exit state's nodes),
- the aggregate claim: scalar-delta on `EmbodiedCarbon` from segment
  start to segment end, bound to the boundary quantities nodes,
- and, in the segment record itself, `stepsRoot`: a Merkle root over the
  per-step commitment hashes inside the segment (`stepCommitHash`: SHA-256
  over the step's fully DERIVED facts - index, mu, prev/new state roots,
  new parameters, backtracks, step size, carbon/merit before+after,
  gradient norm - so the sidecar is a replay aid, never a data channel),

plus the segment's end parameters (24 f64s, so the skeleton can recommit
the boundary state without replaying), step/record ranges and the mu at
entry/exit. Per-step data shrinks to a JSONL sidecar with ONE field per
step (`{"b":backtracks}` - everything else re-derives) and explicit mu-ramp
lines; the sidecar's SHA-256 is pinned in the v2 header. The certificate
wire format is untouched: segment certificates are ordinary v0
certificates, the frozen `packages/provenance` primitives are used as-is,
and v1 chains still verify (the verifier dispatches on the version tag).

`verify-trajectory.mjs` has two modes for v2:

- **FULL** (default): a skeleton pass over every segment (linkage of
  boundary roots, mu schedule from the sidecar, boundary-state recommits
  from the recorded end parameters, segment certificates against
  re-derived payloads only, telescoping carbon aggregates) plus a full
  replay of every segment - per-step exactly the v1 discipline (line-search
  replay, monotone merit, state recommits) ending in the segment's Merkle
  root. Exactly as strong as v1 verification.
- **SPOT** (`--mode spot [--spot-k K] [--seed S]`): the same skeleton
  pass over ALL segments, plus full replay of K seeded-randomly sampled
  segments (default 8). Soundness tradeoff, stated plainly: anything that
  breaks a segment boundary, certificate, aggregate claim, mu schedule, or
  the sidecar bytes is still always caught; a forgery strictly INSIDE
  unsampled segments - a fabricated interior descent path reconnecting
  genuine boundary states with a self-consistent Merkle root and sidecar -
  escapes with probability C(S-t,K)/C(S,K) for t tampered segments out of
  S (e.g. 60% for t=1, S=20, K=8; the miss probability decays as
  (1-K/S)^t for small t). The sample is only meaningful if the prover
  cannot predict the seed: the CLI draws a fresh random seed per run and
  prints it; `--seed` exists to reproduce, not to delegate the choice.
  Both modes verify the endpoint exactly as v1 (kernel re-measurement
  included unless `--skip-kernel`).

Measured on a fresh 4,950-step baseline run (`--max-iter 450` to cap the
per-round iteration count; same optimizer mathematics, endpoint fully
kernel-valid), Apple Silicon, Node 22:

| | v1 (per-step) | v2 (checkpointed, N=256) |
|---|---|---|
| chain size | 10.38 MB (4,960 records) | **39.6 KB** (20 segments) + 44.3 KB sidecar |
| verification FULL (kernel-grounded) | 12.1 s | 11.3 s |
| verification SPOT K=8 (kernel-grounded) | n/a | 4.3 s (8/20 segments replayed) |

That is a ~124x size reduction at equal FULL-verification strength (the
top-level chain alone is 262x smaller; at the original 22,000-step scale
this extrapolates to ~180 KB chain + ~200 KB sidecar vs 46 MB, comfortably
under the 1 MB target). v2 FULL is slightly FASTER than v1 despite doing
the same merit replays because the per-step certificate hashing (6 node
hashes/step) collapses into one SHA-256 step-commit plus 2 recommits and
one certificate per 256 steps. SPOT cost is the skeleton (~0.2 s) + K
segment replays + the endpoint kernel re-measurement.

The v2 tamper battery (`tamper-test.mjs`, dispatches on the version tag)
re-tests every mode on the real chain: a flipped boundary parameter,
faked segment carbon (claim adjusted), broken segment linkage, forged end
root, and a tampered sidecar are all caught by the SPOT skeleton alone; a
consistently resealed sidecar flip and a forged Merkle root are caught by
FULL replay; the endpoint tampers behave as in v1 (including the
consistent forgery caught only by kernel re-measurement). The SPOT
sampling tradeoff is demonstrated, not hidden: the same resealed interior
forgery is DETECTED under a seed whose sample hits the tampered segment
and MISSED under one that avoids it.

What v2 gives up, honestly: (a) SPOT is probabilistic for interior
forgeries - use FULL when the chain's author is the adversary and full
assurance is required; (b) the per-step scalar audit trail (carbon/merit
per step) is no longer stored - it is re-derived during replay, so
inspecting an individual step's numbers requires replaying its segment
(~0.6 s), not a JSON lookup; (c) failure localization in unreplayed
segments is segment-granular, not step-granular. Storage-side there is no
tradeoff: nothing the v1 verifier checked is weaker under v2 FULL.

Reproduce:

```
node scripts/moonshot/diff-spike/optimize-certified.mjs --scenario baseline --out /tmp/b33/v2 --max-iter 450 --emit-v1
node scripts/moonshot/diff-spike/verify-trajectory.mjs /tmp/b33/v2/trajectory-chain-v2.json
node scripts/moonshot/diff-spike/verify-trajectory.mjs /tmp/b33/v2/trajectory-chain-v2.json --mode spot --recheck-cli
node scripts/moonshot/diff-spike/verify-trajectory.mjs /tmp/b33/v2/trajectory-chain.json
node scripts/moonshot/diff-spike/tamper-test.mjs /tmp/b33/v2/trajectory-chain-v2.json --full
node scripts/moonshot/diff-spike/tamper-test.mjs /tmp/b33/v2/trajectory-chain.json --full
```

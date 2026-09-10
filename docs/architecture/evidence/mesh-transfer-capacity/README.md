# Candidate-reuse capacity investigation (#4381)

**Historical negative result: no candidate-cache implementation was merged.** The full
qualified boulder still exceeds the existing 64-million work budget. Keep that
refusal visible; a smaller target is a separate scope, not full-model acceptance.

A later [full selected-target implementation](../mesh-transfer-full-target/README.md)
combines nearest-first traversal and raster padding with a separately reviewed
work allowance. It does not change the results below at the original allowance.

## What was measured

The inputs are the qualified CC0 Poly Haven boulder and its derived captured IFC
from [the original transfer evidence](../mesh-transfer/README.md). All 66,122
source triangles and all 40,087 captured target triangles were retained for the
capacity gate. Source/IFC hashes and exact refusals are in `controls.json`.
These are known-derived surface controls, not independent scan/BIM alignment or
registration-accuracy evidence.

The experiments preserved geometric-nearest selection before normal checks,
near-tie/UV-seam ambiguity refusal, unknown target-albedo preservation, atlas
density, complete target scope and the production work/memory bounds:

- Conservative source BVH leaves for each complete target triangle, then exact
  per-pixel predicates. Only the current triangle's leaves were retained.
- Bounded exact point/normal memoization, followed by bounded lazy spatial cells
  within the target triangle. Candidate order was retained and cache queries
  compared against ordinary point queries.
- Direct exact-distance evaluation with a maximum-distance/ambiguity band to
  avoid redundant point-box tests. It also failed the production capacity gate.
- A centroid/previous-winner seed: vertex witnesses on one fixed source triangle
  bound distance over the whole convex target triangle. The query radius was
  reduced only by a conservative upper bound, with outward floating-point
  allowance and fallback to the original radius. Permutation, seam, thin-wall,
  alternate-nearest and large-coordinate controls passed, but full scope still
  refused. No further tuning was undertaken in this investigation.

The bounded 500-triangle control retains identical complete IFPA bytes, PNG bytes
and observed/unknown counts before/after candidate reuse. Its hashes and counts
are in `controls.json`. Those counts predate the emitted-interior-texel split in
#4423 and must not be presented as raster coverage. The full model was never
silently reduced to that control.

## Worker diagnostic and limits

To distinguish a work proxy from user latency, the fixed-region/cell/memo variant
was run with temporary diagnostic counters through the end of atlas sampling.
The diagnostic **always returns an error before PNG encoding and final
appearance-plan assembly**. It cannot produce an applicable plan. Its expanded
measurement counter is not a product quota change.

`worker.json` contains five fresh Chromium browser/context/module-worker runs on
an otherwise idle machine, plus one cancellation trial. It records worker
startup/message roundtrip, input decode/registration/native time, API-call time,
WASM linear-memory high-water, main-thread heartbeat gaps, and sampled summed
browser-process RSS. Input fetching precedes the roundtrip timer. Process RSS
includes browser, input and JS overhead, may double-count shared pages, and is
sampled rather than a precise peak allocation. `Worker.terminate()` call latency
is not proof of operating-system memory-reclamation latency. Every completed run
reports the same charged traversal and returns no plan.

This is one machine and one qualified model. It is not complete Apply/export
latency, a production worker-pool speedup, or evidence to raise the quota. A quota
review would need normal and adversarial source/target cases, memory peaks,
responsive cancellation and host transaction acceptance together.

## Reproduction

The unmerged experimental sources are pinned separately:

- [Calculation-only worker diagnostic](https://github.com/LTplus-AG/ifc-lite/commit/ffaec2be2)
- [Seeded-region production-cap experiment](https://github.com/LTplus-AG/ifc-lite/commit/cdffd6763)

Do not merge either spike branch. Build its WASM in an isolated worktree with a
source-specific Cargo target. Obtain the qualified local assets documented in
the original evidence, then generate the exact worker payload without invoking
an application loader:

```sh
python3 tools/texture-authoring/boulder-transfer-probe.py \
  /path/to/boulder-albedo.glb /path/to/captured.ifczip \
  --write-input-json /tmp/transfer-input.json
node tools/texture-authoring/transfer-worker-diagnostic.mjs \
  /path/to/diagnostic-worktree /tmp/transfer-input.json /tmp/worker.json
```

Run the harness from a checkout with its normal Playwright dependency installed
(or supply that dependency checkout as the fourth argument). It binds an
ephemeral loopback port, accepts only fixed resource routes, creates fresh browser
contexts, terminates every worker and closes its own browser/server handles.
Input reads are bounded. The recorded payload hash distinguishes this full-model
fixture from another generated capture. No large scan/IFC inputs are committed.

## Nearest-first traversal follow-up

A separate [unmerged nearest-band experiment](https://github.com/LTplus-AG/ifc-lite/commit/e74b81ee6)
tried a different mechanism: visit the nearer BVH child first, shrink the search
radius after each exact primitive distance, and retain all candidates inside
the final nearest-distance plus ambiguity band in that same traversal. Exact
point/normal memoization is capped at 1,024 entries. It preserves nearest-surface
selection before normal checks and does not increase the aggregate work limit.

The full selected 40,087-triangle boulder target against all 66,122 source
triangles still returns `BVH query work budget exhausted`; no applicable plan is
produced. [Pinned input hashes and refusal](nearest-band.json) identify the
control. Native tests cover thin opposite faces, overlapping/UV-seam ambiguity,
unknown albedo and emitted texel applicability, plus independent nearest/band
point-distance checks and explicit budget failures. This is a capacity refusal,
not a performance improvement or full-model acceptance. Timing was deliberately
not compared while other builds were active. No nearest-query or memo-cache code
from this experiment is merged into the product.

For native reproduction, use the existing input generator above, split its
`source`, `request`, and base64-decoded `rgba` into `source.ifc`, `request.json`,
and `rgba.bin`, then run from the pinned experimental checkout:

```sh
cargo run -p ifc-lite-processing --example transfer_nearest_probe \
  --profile server-release -- /path/to/input-directory
```

The example only reports planner metadata or refusal; it never publishes a
mutation. The selected product is #65, whose geometry item #54 retains all
40,087 triangles. Other products in the IFC are outside this explicit target.

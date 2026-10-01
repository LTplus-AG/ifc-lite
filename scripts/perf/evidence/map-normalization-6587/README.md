# Map geometry compatibility export (#6587)

Implementation head `3217508b67b871c65d9e30106e6fa6afcdf8d01c` adds an
opt-in canonical Rust planner and asynchronous STEP application seam. Default
geometry is unchanged. The supported subset and atomic warning contract are
documented in `docs/guide/exporting.md`.

`production-export-stats.json` records a real `StepExporter.exportAsync` call
with session-edited `Name`, both coordinate compatibility options, and the
fresh WASM runtime. Source SHA identifies the public buildingSMART bridge deck
catalogued under `tests/models/ifc5/`; fixture bytes are fetched rather than
committed. `production-independent-oracle.json` compares actual retained
IfcOpenShell mesh vertices against the original source's map transform, checks
both nearest-distance directions, validates EXPRESS, and verifies edited Name
and GlobalId preservation. These are physical-coordinate checks, not bounds.

The two `*-oracle.json` reports are from the repository's supported
`check-test-revert-oracle.mjs --mutation` lane. Each retains the complete API and
tests, has an attributable green baseline, observes runtime assertion failure,
and verifies source restoration. The patches intentionally reverse transform
order or omit strict target-unit validation; neither relies on an import or
compile failure. Reproduce from the implementation head with:

```bash
node scripts/check-test-revert-oracle.mjs --base d7267b5c0 --head HEAD \
  --only rust/export/src/step_map_transform.rs \
  --test rust/export/src/step_map_transform_tests.rs \
  --mutation scripts/perf/evidence/map-normalization-6587/transform-order-mutation.patch \
  --json
```

Use `strict-map-unit-mutation.patch` for the second proof. A later main-based
port uses its own actual base/head; the retained tests and mutation API remain
the same.

`native-default-pairs.json` contains five alternating base/branch pairs, each
running `scripts/perf/probe.sh` with five iterations and ordered mesh
fingerprints on AC20-FZK-Haus. Base is a fresh isolated build of main
`89be760d4eb8adba93e9f5660f6e4ceda0c507d5`. Measurements ran with other builds
and browser decoding paused. The native hash covers the documented ordered
mesh payload subset, not all exported metadata or textures. No performance
improvement is claimed.

`browser-timing-summary.json` records the genuine native T3 browser cohort.
Each sample loaded the house fixture first in a new tab at a distinct origin,
with cross-origin isolation and the real shared-buffer worker pool qualified.
The byte witness includes flat mesh and instanced payloads. An earlier sample
without isolation was rejected rather than included. The browser process and
OS caches were shared; the measured events come from emitted worker/readiness
boundaries rather than tool polling latency.

`export-default-pairs.json` records the actual asynchronous STEP API on the
same parsed house fixture. Fixed header timestamps allow exact output-byte
comparison. `export-timing-summary.json` additionally records separate default
and opt-in public-deck calls, including cold first-call import/init cost.

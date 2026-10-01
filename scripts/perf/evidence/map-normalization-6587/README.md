# Map geometry compatibility export (#6587)

Original implementation head `3217508b67b871c65d9e30106e6fa6afcdf8d01c` adds an
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

The two `*-oracle.json` reports were refreshed against actual main prerequisite
`7780cb058` and corrected head `d30838cd8` using the repository's supported
`check-test-revert-oracle.mjs --mutation` lane. Each retains the complete API and
tests, has an attributable green baseline, observes runtime assertion failure,
and verifies source restoration. The patches intentionally reverse transform
order or omit strict target-unit validation; neither relies on an import or
compile failure. Reproduce from the implementation head with:

```bash
node scripts/check-test-revert-oracle.mjs --base 7780cb058 --head HEAD \
  --only rust/export/src/step_map_transform.rs \
  --test rust/export/src/step_map_transform_tests.rs \
  --mutation scripts/perf/evidence/map-normalization-6587/transform-order-mutation.patch \
  --json
```

Use `strict-map-unit-mutation.patch` for the second proof. These preserve the
planner API, including the corrected product-Body ownership guard.

`qualified-default-cohorts.json` retains every replacement native/STEP call,
every native-browser sample, artifact hash, summary, and sanitized hardware
qualification. Base is `7780cb058`, corrected Rust code is `c592decc8`, and the
frozen branch head is `d30838cd8`. A later follow-up fixes only an incomplete
MPL notice in the JS contract harness and records this evidence; it changes no
Rust or load/export behavior. Final WASM is regenerated after mutation-proof
restoration and its freshness is checked before acceptance.

Four continuous-GPU Cesium validation tabs were stopped before replacement
measurements. Agent-controlled builds, uploads, and GPU checks were held;
unrelated user applications were not closed. DOM visibility history is retained,
but the native panel reported not physically visible despite open/show requests.
This measures emitted readiness boundaries in the actual shared native browser,
not physical foreground painting or a cold browser process.

`unqualified-default-cohorts.json` retains both earlier exact-base browser
cohorts and their native/STEP counterparts. The later GPU audit disqualifies
their timing claims. They remain diagnostic, are not pooled, and are not silently
discarded. The older original-base records below predate this qualification and
are historical witnesses; only the qualified replacement establishes the verdict.

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

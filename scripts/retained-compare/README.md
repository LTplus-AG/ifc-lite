# Retained browser parity (#7955 M2-D)

The browser harness serves an already staged, inventory-validated engine with
`serveRoots`. It keeps one real `RetainedModelSession` warm across the committed
coverage manifests (including per-slice fragments), running shape and view detail for each model. Native
`products.tsv` is read unmodified; its SHA256 is recorded in `summary.json`.
`retainedReport` supplies the f64 volumes and `metrics.compare` enforces the
preregistered 1e-9 native/browser tolerance. M5 registers a 1e-7 exception only
for rows with a passing `clipSectionVolumeRelative` source oracle whose
`sourceCurved` metadata is true. A runtime `curved` flag alone never qualifies;
planar clips and unclipped curves retain 1e-9. The source-oracle limits remain
unchanged, and `scopedVolumeRows` records every selected exception. The M5
registration records the measured gap, evidence path, and approved margin.
View checks independently authenticate
the prepass RTC, product outcomes, triangle counts and half-ULP vertex storage.
Neither this harness nor the mutation witness changes tolerance registrations.

Build the CLI through root Turbo, build the retained WASM through
`BUILD_RETAINED=1 pnpm build:wasm`, stage the engine with
`scripts/stage-cli-retained-engine.mjs`, and generate the native committed
comparison with `retained_compare --committed --gate`. Then, inside fleet
admission (use the machine's launcher, never nest reservations):

```sh
IFCLITE_RETAINED_ENGINE=/absolute/engine \
IFCLITE_NATIVE_PRODUCTS=/absolute/native/products.tsv \
IFCLITE_BROWSER_OUT=/absolute/results \
node --test scripts/retained-compare/browser.test.mjs

rm -rf apps/viewer/dist # discard outputs from a previous build mode
VITE_RETAINED_GEOMETRY=on IFCLITE_RETAINED_ENGINE=/absolute/engine \
pnpm build:e2e --concurrency=1
VITE_RETAINED_GEOMETRY=on IFCLITE_RETAINED_ENGINE=/absolute/engine \
IFCLITE_VIEWER_OUT=/absolute/results/e2e \
pnpm exec playwright test --project=viewer-retained

rm -rf apps/viewer/dist
VITE_RETAINED_GEOMETRY= IFCLITE_RETAINED_ENGINE= pnpm build:e2e --concurrency=1
node scripts/check-viewer-retained-free.mjs
VITE_RETAINED_GEOMETRY= IFCLITE_RETAINED_ENGINE= \
pnpm exec playwright test --project=viewer-retained-default
```

The e2e project starts its own flagged preview and refuses an occupied port;
`PLAYWRIGHT_PORT` chooses the port. It uses installed Chrome by default;
`IFCLITE_BROWSER_CHANNEL=chromium` selects Playwright's full Chromium (not its
headless shell). All waits observe viewer state, DOM or Worker events. Expected
published/refused rows come from the current manifest, whose parity is checked
against the native and browser engine runs first. A missing engine reports
`SKIP: no staged SMLib engine; this is NOT parity evidence`. CI checks the engine
and native files exist before running, so absence cannot make the lane green.

`summary.json` records real SDK qualification plus module import startup, controller product
time and callback wall time p50/p95 (observed qualification subtracted), and the peak
retained WASM heap across runs. The SDK linear heap is private to its Worker;
when supported, `measureUserAgentSpecificMemory` records aggregate browser/Worker
memory, explicitly not an isolated SDK heap measurement. These are observational
figures, not a performance ratchet or an idle-host benchmark. The e2e records
long-task duration and gates only on Cancel latency. Keep all generated evidence
outside the repository. Optional downloaded corpus runs use `--corpus` and are
report-only; browser parity never blesses or rewrites a reference.

The SMLib-free witness runs with:

```sh
node --test scripts/retained-compare/browser-metrics.test.mjs
```

`tests/evidence/m2-d/oracle.json` registers the reverse-applied mutation that casts
both world coordinates to f32 before comparison. The georeferenced one-ULP
witness must fail under that mutation and pass after restoration.

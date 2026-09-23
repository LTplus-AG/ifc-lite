# Export and deployed-delivery qualification (#5357)

Verdict: **no runtime change qualifies for shipment from this round**. This is a
completed spike/evidence PR, not an implemented production optimization. The patch
is archived data and is not applied to the source tree. The strongest next native
candidate is bounded GLB replay; deployed Brotli remains a browser-delivery
candidate. Georeferencing suppression is a narrower, lower-priority export option.
None establishes a normal viewer model-load speedup.

## Experiments and decisions

| Mechanism | What was actually exercised | Decision |
| --- | --- | --- |
| Bounded GLB disk replay | Record visible input geometry during the existing planning pass; replay through the unchanged byte writer, without a second mesh pass | Keep as a promising native experiment. Scratch-disk dependency, typed error handling and uncontended full-path A/B qualification remain prerequisites; do not activate this prototype. |
| Omit trailing georeferencing | Experimental suppression at the extraction seam; compare complete GLB artifacts, keeping RTC and site-transform work intact | Park. Indexed property-set candidate decoding still has a cost, but the old whole-file-scan explanation is obsolete. No qualified incremental end-to-end win or consumer-scoped public API is established. |
| Deployed WASM delivery | Fetch actual deployment asset with identity, Brotli and gzip; verify decompressed identity; fetch/compile in a fresh Chrome process; recompress the same bytes locally | Park the compression change. Live delivery already negotiates Brotli. Local quality-11 savings are potential only; CLI authentication is absent, so no modified deployment was tested. |

## Native provenance and boundary

Base: `4e2c52f33` (latest main fetched at the start of this round). The baseline
binary was built from that Rust source plus only the archived `bounded_spike`
example. The candidate is exactly `candidate.patch` applied to that base. Both
use the pinned toolchain and `cargo build --profile profiling -p ifc-lite-export
--example bounded_spike`. `provenance.json` pins the full base, binary hashes,
patch, fixtures and toolchain. No historical committed baseline was used.

`functional-original.py.txt` preserves the original observer and its local paths.
`functional.py` is the portable replay added during review: it discovers fixtures
relative to the checkout (or `--fixture-root`), accepts explicit binary/output
paths and creates missing output parents without overwriting a prior run. Build
and freeze the baseline executable before applying the patch; then build/freeze
the candidate separately:

```sh
python3 scripts/perf/evidence/export-delivery-5357/functional.py \
  --base-bin /path/to/base-probe --candidate-bin /path/to/combined-probe \
  --output /path/to/new-results
```

Use repeated `--fixture <relative/path.ifc>` flags to select a smaller corpus.
 Set `IFC_SPIKE_SPOOL` to a fresh scratch path to enable
replay; use `IFC_SPIKE_GEOREF=skip` for the separate suppression experiment.
`IFC_SPIKE_GEOREF=timed` retains extraction and reports attribution only.

Each invocation is a fresh process. The probe measures source-file read through
completed GLB and scratch-handle cleanup, then output-file writing (page-cache
completion, not fsync/durable persistence). Hashing is outside the timed boundary.
The full export includes scan/parse, geometry, planning, scratch read/write and
serialization. It does not pretend to split this into independently timed parse
and geometry phases. GNU time captures RSS and filesystem I/O; scratch-byte
counts are in stderr. No claim is made about tmpfs, cold OS caches, slow disks,
concurrent exports, or all native platforms.

**All recorded elapsed times are unqualified diagnostics.** This is one
functional comparison per fixture/mode, not five alternating A/B pairs. Concurrent
builds and other Turbo/Node work were present; per-run `host` snapshots in `observations.jsonl` retain
PID/command/CPU/RSS without other processes' arguments. Do not calculate or quote
a speedup from this cohort. No timing cohort was selectively retried to obtain a
win. A production perf PR still needs the repository's full qualification contract.

The corpus covers Haus, ISSUE_129 CSG, ISSUE_098 large coordinates, Holter and
issue-472 spline geometry, each in f32 and quantized form. `results.json` records
whole-artifact SHA-256; per-run stdout in `observations.jsonl` records FNV, byte size, mesh/vertex/triangle
counts, materials and unverified-instance-group counts. Exact artifact equality
compares compatibility with the current exporter, not independently verified
geometric correctness; existing bounded-instancing limitations remain unchanged.
All 30 exports completed successfully; both experimental arms matched base in all ten fixture/encoding groups. Source IFCs and generated GLBs are not committed.

## Tests and limitations

The spike-enabled existing glTF tests passed (78 tests, no failures), with real
fixtures available. Command:

```sh
IFC_SPIKE_SPOOL=/tmp/unique-spike-scratch cargo test -p ifc-lite-export gltf -- --test-threads=1
```

They cover visibility, quantization, instancing/world geometry and bounded-output
identity. This is **not** a full workspace, WASM-boundary, disk-fault or portable
filesystem qualification. No Rust production source is changed by this PR.

The prototype uses an exclusive file and immediately unlinks it on Linux. It
buffers writes, retains at most one emitted batch while recording, and one mesh
while replaying; it does not retain the entire geometry collection. However it
uses `expect`/`unwrap` on experimental I/O, does not establish a portable temp-file
policy or scratch capacity/permissions contract, and does not expose a supported
consumer opt-in. `spool-io-failure.json` demonstrates that an unavailable scratch
location panics, with no GLB output. That is a known **non-shippable limitation**,
not a passing production error-handling test. Size projection remains the current
metadata-only path; multi-buffer glTF and browser WASM were not changed.

The georeferencing switch is intentionally global only in the throwaway patch;
shipping it would incorrectly suppress server metadata. A real implementation
must be scoped to audited export callers and preserve the existing public
`StreamingOptions` struct-literal compatibility. Site transforms and RTC rebasing
must not be suppressed with metadata.

`setup-failures/` preserves the initial probe-launch failure (the frozen binary
was not available yet) and the successful Haus setup retries. The named corpus
cohort was started only after both binaries were frozen. These setup observations
are not extra benchmark samples.

## Actual browser delivery

`wasm-url.txt` identifies the content-hashed deployment URL, not an inferred
bundle size from a local build. The response headers (line endings and trailing whitespace normalized) identify deployment/cache,
MIME type and encoding; `compression.json` records raw/compressed sizes and
checks that both served encodings decompress to the identical WASM SHA-256.
`delivery.json` records a fresh Chrome process, the real Resource Timing encoded
and decoded byte sizes, and successful `WebAssembly.compileStreaming` exports.
It is a fetch/compile observation, **not** a completed worker-pool/model/render
benchmark; connection establishment overlapped prior page navigation.

`delivery-original.mjs.txt` preserves that original observer, including the
historical disabled-sandbox launch setting. The portable `delivery.mjs` now
resolves Playwright from the checkout, reads the adjacent pinned URL, accepts an
optional browser executable and a required output path, and explicitly enables
Chromium's sandbox. It has no sandbox-disabling fallback; use a non-root account
on a host where Chromium's sandbox works. An independent live replay with that
setting succeeded; `portable-verification.json` records the check without
replacing the original observations.

```sh
node scripts/perf/evidence/export-delivery-5357/delivery.mjs \
  --browser-executable /path/to/chrome --output /path/to/new-delivery.json
```

Omit `--browser-executable` to use Playwright's installed Chromium. Output files
are never overwritten. The first naive static search (`discover.py`)
missed backtick-quoted hashed URLs and found a non-existent un-hashed asset;
that URL returned 404. Inspecting the deployed exporters chunk located the actual
hashed URL used by the runtime. Only successful responses from that URL enter
`compression.json` and `delivery.json`.

`compress.mjs` reproduces the compression calculation. In a scratch directory,
fetch `wasm-url.txt` with `curl -H 'Accept-Encoding: identity' -o identity.wasm`,
then separately `br` to `br.wasm` and `gzip` to `gzip.wasm` (do not use curl's
`--compressed`, which would decode the bodies). Run the script in that directory
and compare its JSON to `compression.json`. These network requests may outlive
the deployment asset, so the original headers/digests remain the recorded proof.

Local quality-11 output cannot prove deployability: Vercel controls compression
([official CDN documentation](https://vercel.com/docs/how-vercel-cdn-works)).
`vercel-account.log` records the failed authentication check; no deployment or
production setting was changed. Qualification requires an authenticated preview,
encoded-response and decoded-byte checks on that preview, then fresh-browser
full-load comparisons under controlled network conditions. The current compile
memo and worker module sharing already exist; neither is a new proposed win.

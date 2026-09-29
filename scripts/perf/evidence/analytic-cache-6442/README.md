# Mapped analytic cache A/B (#6442)

This is an opt-in native measurement of the combined analytic quantity-source
walk. The control sets the existing `cfg(test)` cache flag to false; production
builds retain the bounded cache and have no runtime switch. Each invocation
reads one IFC, runs one extraction in a fresh process, then serializes all
ordered descriptions, swept-disk definitions and extrusion definitions.
The runner rejects any byte difference in that complete JSON within a fixture.
That comparison includes source records, nominal quantities, occurrence order,
world transforms, statuses and diagnostics.

From a clean checkout with the catalogued Snowdon fixture (`pnpm fixtures`):

```sh
cargo test --release -p ifc-lite-processing --lib --no-run
# Use the exact executable path printed by Cargo, not a .d file.
python3 scripts/perf/analytic-cache-ab.py \
  --binary target/release/deps/ifc_lite_processing-<printed-hash> \
  --snowdon 'tests/models/various/01_Snowdon_Towers_Sample_Structural(1).ifc' \
  --output scripts/perf/evidence/analytic-cache-6442/results.json
```

The runner verifies Snowdon's manifest SHA-256, records the source commit,
compiler, host and binary SHA-256, and runs five interleaved pairs per fixture.
Pair order alternates control/cache and cache/control. The generated 1,024-item
case shares one map; the nested case adds mirrored and scaled mappings. The
same test harness constructs both generated cases outside the timed call.
The IFC read is likewise outside the timed call. `elapsed_ns` brackets only the
analytic extraction. `peak_rss_kib` is the kernel's VmHWM immediately after
the call, with `baseline_hwm_kib` recorded before it; the test also samples
VmRSS every 1 ms during the call. These process RSS measures include the
test runner and the IFC already read into memory. The separate
`standalone_index_ns` sample runs after extraction on the same bytes and is a
parse-cost reference, not a decomposition of `elapsed_ns`. The canonical API
builds its index and scans products inside the measured call, so an exact
parse-versus-walk split is unavailable without changing that code. The OS file
cache is not purged. All timing conclusions must use the paired range and
observed noise, not a single ratio.

`results.json` contains every raw run and paired summary. It is scoped to the
opt-in analytic call. Existing ordinary mesh-output fingerprints and browser
worker-pool performance are separate questions.

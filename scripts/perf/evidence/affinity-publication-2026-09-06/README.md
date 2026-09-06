<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# Incremental affinity publication: local candidate

The prepass previously computed all remaining geometry routing keys before
publishing bulk jobs. It now publishes each existing chunk immediately after
computing that chunk's keys. The decoder, signature memo, first wave, job order,
chunk boundaries and type-geometry tail are preserved. Earlier publication can
overlap routing with geometry processing; it does not eliminate geometry work.

This evidence accompanies the incremental-publication change for #4051. The primary
measurement is [results.json](./results.json): alternating base/candidate order,
fresh Chrome processes, fixed source-built distributions and real IFC input.
The equal-model aggregation applies only to the listed subset, not the original
full corpus. OS file cache was not flushed. No native or Firefox speedup is
established. Earlier overlap can increase peak memory.

## Artifact attribution correction

The private run directory names contain `combined`. Those labels are wrong:
the intended map-cache-plus-publication build reused the affinity-only Cargo
artifact after timestamp-preserving source restoration. Turbo was forced and
the bundled engine matched the package engine, but that did not establish that
Cargo had recompiled the restored source. The combined build log reported no
crate compilation. Its binary was identical to the affinity-only binary.

The map-cache source was archived and removed from the working patch. Final
validation removed the crate's WASM release output, recompiled the affinity-only
source and obtained an exact binary match to the frozen measured artifact. See
[validation.json](./validation.json) for commands, source and log hashes. The original mislabeled
manifests and runs are preserved; no combined-candidate gain is claimed. The
separate cache-only screen is a modest exploratory result and is not added to
the publication result.

## Correctness coverage and limits

Every timed run exercises actual properties, hierarchy, search and GPU picking.
The projection compares mesh/triangle counts, geometry fingerprints, AABB bits
and volume bits. Spatial query definitions and result multisets must match;
result order may differ with worker completion order. Those queries cover the
flat spatial publication, not every instanced-only entity or the lazy renderer
CPU BVH. No full real-model vertex-buffer or closure equivalence is claimed.

The actual-WASM contract exercises multiple chunks and scratch-buffer reuse,
including exact source spans, complete ordered job IDs, owned callback arrays,
first-wave routing, prerequisite event order and repeated prepasses. A separate
private whole-MEP prepass comparison checks every published event payload
against the base implementation.

No uncaught page errors or target crashes are allowed in the result projection.
Raw diagnostics retain a pre-load analytics resource error; this is not a claim
of a completely clean console. Memory observations extend through background
cache settlement. Cache reopening and federation are not newly qualified here.

## Reproduction and private evidence

The base reference and binary hashes, per-run source-result hashes, measurements
and comparison witnesses are in the JSON projection. The private archive is
`/Users/louistrue/ifc-cold-load-t3-2026-09-06`; original fixture paths, screenshots,
console logs and full spatial result rows are kept there rather than published.
It contains frozen distributions, source snapshots, original build logs,
`screen.py`, `report.py`, `project_results.py` and the older diagnostic screens.
The runner uses the previously reviewed local `bvh-acceptance/chrome.mjs`
harness; it does not substitute a kernel microbenchmark for viewer loading.

For future comparisons, force source mtimes forward or use a fresh target
directory after switching variants. Verify actual Rust recompilation as well
as bundled WASM hashes. Never treat a copied provenance manifest as proof of
compiler inputs.

# Point-depth qualification resumed (#6881)

Qualification is in progress. No new hardware, federation, or hover-performance
acceptance follows from preparing these harnesses.

The bounded sampler and ownership repair already shipped in #7389. The subsequent
device-loss fix and 28 real-model same-render comparisons shipped in #7506; see
[that evidence](../pick-device-loss-6881/README.md). The earlier
[performance hold](../../../scripts/perf/evidence/bounded-depth-readback-6881/README.md)
remains part of the record.

The production source under test is `97d8add207104d5801c0c8d62e40fa7066e848f8`.
The private diagnostic control is `28dff46ee6ba0681091303e307d73e56bb3facbd`,
whose parent is that production source. Its only production-file difference
restores a full-depth staging copy in `Picker.pick` and enables `COPY_SRC` on
the depth target. Render, floor/clamp, decode, RTE snapshots, ownership repairs,
rectangle picking, and CPU fallback remain the same. This isolates the readback
mechanism without comparing unrelated viewer revisions. This control is a local
qualification ref, not a proposed production fallback.
The [exact inverse patch](full-copy-control.patch) reproduces that control from
the pinned production source.

Preparation receipts:

- Production build request `auto-f10eab2510224f879bc830b842570eec`, Pop job
  `0daaae21-0c18-48d9-b978-74a6729d212e`: failed with exit 134 at Node's heap
  limit during viewer bundling. Its 55 preceding Turbo tasks passed; the viewer
  build did not. Four optional IFCX package build fixtures were absent and skipped.
- Control request `auto-d74a5858b89141a7a2cce63de6772f9d`, PC job
  `b7bb7bc6-1d09-44dc-bdc8-31f6ef0754c4`: completed with exit zero and clean,
  unchanged source. Its native performance was not measured on PC.
- Control transfer `86036071-d674-414a-a403-0a762146a892`: completed with exit
  zero. All 965 artifact files were checked against the original successful
  producer. The staging command ran from a dirty harness checkout: its before
  and after identities match, but `sourceUnchanged` is false because that worker
  field also requires clean source. It is not a clean source-build receipt.
- Corrective Pop build `a07ca80f-5392-416f-b641-674ca6cce39d`: uses the inspected
  machine-qualified profile with an 8 GiB Node heap, 24 GiB reservation and serial
  Turbo execution. All 56 root Turbo tasks passed (55 cached), with exit zero
  and clean, unchanged source.
- Common-engine rebundle `3a07710a-1c81-4f46-895c-23a4c62da0eb`: passed with exit
  zero and clean, unchanged source. Pop and
  PC produced different WASM bytes from identical Rust inputs, so the
  [repack controller](../../e2e/pick-depth-6881-common-runtime.py) verifies those
  inputs and reuses the PC producer's exact generated runtime before rebuilding
  the production viewer through root Turbo.
- Exclusive qualification `df597d9b-e93a-499d-a2ba-3375e5ab4650`: queued after
  that prerequisite. It runs functional controls first and launches timing only
  after those pass. The original request and output must be reconciled after an
  interruption; this is not a retryable sample identifier.

[Preparation receipts](preparation.json) retain command/source identities,
original outcomes and log hashes. GPU and hover acceptance remain pending.

## Functional protocol

Run [the native controller](../../e2e/pick-depth-6881-native.mjs) under registered
service admission with a successful original build receipt and a new output
directory. It uses the retained Linux physical-console browser workflow from
#6709, a 1440 × 900 CSS viewport and controlled DPR 1 and 2. Collapse the sidebar
through its normal UI before the first load, as required by that workflow's
documented location-map driver diagnostic.

Load the catalogued public FZK fixture through Open, then add the catalogued
buildingSMART architecture fixture through Add. Require authoritative metadata,
geometry and scene-finalization completion. The
[observer](../../e2e/pick-depth-6881-observer.mjs) locates the already mounted
renderer; it creates no second viewer or load pipeline. Package input hashes
must match the built viewer's source before it is bundled.

Append independent full-depth and ID copies to each production pick's render
submission. Compare depth bits, encoded ID, decoded entity/model/item and world
position using that call's captured matrix and immutable RTE snapshot. Fixed
grids include borders, outside coordinates, overlapping calls, isolated model
subsets and an excluding crop. Require flat-mesh ownership witnesses for both
models; retain the existing instanced shader's absent model/item channels.
Fingerprint complete geometry fields and typed arrays as a canonical mesh
multiset before and after picking; worker publication order is not geometry
identity. A corrupted-depth inverse must reject. Hold two real completed
maps across camera movement, resize and device loss; require stale-result
rejection and exactly-once destruction of the six per-pick buffers.

The existing #5049 renderer raster witness additionally supplies flat/textured
meshes, instances, points, crop controls and a 5,000 km origin. Require nine
matching same-render samples and actual mesh/instance/point hits at each DPR.
Its authored geometry is a stated invariant, not a real georeferenced IFC.
Record actual family coverage and remaining gaps explicitly.

## Hover protocol

Only after the required functional controls pass, run
[the hover cohort](../../e2e/pick-depth-6881-benchmark.mjs) under exclusive
registered benchmark admission. Its frozen configuration must bind successful
producers, clean source identities, all served artifact hashes, identical engine
bytes and the successful functional report. Never replace a failed timing sample.

Use five counterbalanced pairs for each declared public-model scenario, with a
fresh native browser/profile per sample. Require the actual WASM loader path
and retain its cache write-policy tier. Drive nine actual pointer movements at
300 ms spacing through the mounted hover handler. The
[passive tap](../../e2e/pick-depth-6881-hover.mjs) records pointer-to-store latency,
picker latency, buffer allocations and mapped bytes without adding GPU commands.
Require identical geometry, camera matrices, texels, IDs/items/model provenance
and world positions, plus foreground, host, GPU and driver health. Report paired
interaction measurements separately from allocation savings and loading behavior.

Syntax, changed-file lint and browser-module bundling have passed. The
[eleven fingerprint controls](fingerprint-controls.json) distinguish positions,
indices, normals, colors, coordinate origin, signed zero, instance hashes, item
identity and mesh multiplicity; they preserve collection-order independence and
refuse incomplete publication. The native controller invokes the
[same controls](../../e2e/pick-depth-6881-controls.mjs) before browser startup.
These are harness algorithm checks, not actual-GPU coverage.

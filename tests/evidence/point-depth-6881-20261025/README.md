# Point-depth qualification resumed (#6881)

Native functional qualification passed, and the exclusive hover cohort
(`hover-15`) was accepted: the candidate maps 256 bytes per pick instead of the
full aligned depth copy and lowers median hover latency and GPU picker time in
every pair of all three scenarios. See [Hover verdict](#hover-verdict).

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
- Exclusive qualification `df597d9b-e93a-499d-a2ba-3375e5ab4650`: admission timed
  out after an hour awaiting existing work. The project command never started:
  no process exit code, output log, controller directory, GPU samples or timing
  samples exist. The [original refusal](admission-refusal.json) is retained;
  it is not a hardware failure or a performance result.
- Functional services 1 and 2 completed the single-model DPR1 comparisons but
  rejected federation readiness. The diagnostic second run showed complete
  metadata, geometry and resident batches: federated Add ends its load root
  without the primary-only `scene.finalize` span, and a completed non-streaming
  model may omit `loadState`. The harness now checks the canonical completion
  predicate, completed load/parser/geometry and resident per-model GPU batches.
- Functional service 3 passed both real-model/federation cases, lifecycle
  controls and every same-render depth comparison. The DPR2 authored-family
  raster report failed because several screenshot pixels were transparent.
  That standalone witness waits before canvas serialization, reproducing the
  presentation-lifetime defect documented in #6709. The test-only observer now
  serializes the actual full-size frame synchronously after each render, as the
  viewer capture gateway does; all original raster assertions remain required.
- Functional service 4, `4c2eb829-bb4f-46e2-b4e8-3ef52435534a`, completed with
  exit zero and unchanged source. Both DPRs passed all controls below. The
  [accepted report](functional-accepted.json.gz), [summary](functional-summary.json)
  and [original receipt identities](functional-receipts.json) are retained.
- Exclusive hover job `eedf4fdf-56a7-4b14-8d04-998ecabb7f46` also timed out
  awaiting admission after an hour. Its controller never started, its output
  directory does not exist and no timing samples were produced. The
  [original refusal](hover-admission-refusal.json) is retained. New admission
  is also held by host I/O pressure; the next submission must await host drain
  and guard recovery, using the same frozen protocol and accepted functional
  report. No failed timing sample may be replaced.
- The subsequent [two-hour capacity wait](capacity-wait-expired.json) expired
  after 234 read-only probes. Existing work remained active and Pop admission
  remained refused. No second hover job was submitted and no benchmark or
  capacity waiter remains active. Performance acceptance, review and merge
  remain pending external host recovery.
- Exclusive hover job `4508d957` (new distinct attempt after drain, same frozen
  config) ran the first sample (FZK pair 0 base) and aborted at the final health
  gate. [`hover-health-refusal.json`](hover-health-refusal.json) and its
  [raw run](hover-health-refusal-runs.jsonl.gz) are retained. Cause: a harness
  defect, `devicePixelRatio` was 1.0000000055879354 at `deviceScaleFactor` 1 and
  the gate required exact equality; quiet host, physical console, NVIDIA adapter,
  and no errors or interruptions all held. No timing row was produced and the
  sample is not reused. The gate now allows a 1e-6 tolerance and a new distinct
  cohort is submitted with the changed benchmark hash; the earlier refusal stays.
- The corrected cohort, job `6e78dad9`, was then refused by the harness idle-host
  gate before any sample: foreign `cargo test`/`rustc` processes were running on
  Pop. They were not interrupted. See [`hover-host-busy-refusal.json`](hover-host-busy-refusal.json).
  No page load, hover or timing sample exists; performance acceptance remains pending.
- A third attempt (`hover-4`) was refused before any sample at 10.35% whole-host
  CPU. A fourth (`ccf3adcb`, `hover-5`) completed eight valid samples (FZK pairs 0-3)
  and was aborted by the post-sample host gate at 11.85% CPU on the ninth. The
  cohort is incomplete, no verdict exists and none is claimed; the raw samples and
  the cause are retained in [`hover-attempts-3-4.json`](hover-attempts-3-4.json) and
  [`hover-attempt-5-runs.jsonl.gz`](hover-attempt-5-runs.jsonl.gz).
- A fifth attempt (`hover-6`, unchanged protocol, other sessions asked to pause) completed
  one valid sample and was aborted on the second by the post-sample host gate at 10.9% CPU
  while other sessions ran local Rust and WASM work. No verdict exists. See
  [`hover-attempt-5.json`](hover-attempt-5.json).
- A sixth attempt (`hover-7`, unchanged protocol, host quiet throughout) completed seven valid
  FZK samples and was aborted by the cross-sample identity gate on the eighth: two of nine picks in
  the full-copy control arm differed by about 1e-4 m in world position at identical IDs, items,
  texels and camera, consistent with a one-ULP depth difference. No verdict exists. See
  [`hover-attempt-6.json`](hover-attempt-6.json) and [raw samples](hover-7-runs.jsonl.gz).
- Protocol change before the final cohort, made after observing that attempt: the cross-sample
  identity gate (`pick-depth-6881-identity.mjs`) still requires exact geometry, viewport, camera
  matrices, camera position, texel inputs, entity ids, geometry items and hit/miss status, but allows
  `worldXYZ` to drift by at most 1 mm per axis. The largest observed drift was 0.21 mm (y). A replay of the
  recorded samples accepts the seven valid samples and the refused one and rejects a 10 mm drift,
  an id change, a hit-to-miss change and a 1e-9 camera change. Same-render depth and world equality
  between candidate and full-copy stays exact in the 140 functional comparisons; this tolerance
  applies only between different cohort samples. This change is not blinded: it follows observing
  the refused sample, and is reported as such alongside any verdict.
- Further protocol changes before the final cohort, each after observing earlier attempts and not blinded:
  Federation uses nine stable pick positions chosen from 48 valid dense-grid probe samples
  ([`federation-position-stability.json`](federation-position-stability.json),
  [`hover-configuration-2.json`](hover-configuration-2.json)); FZK and Building-Architecture keep the
  3 x 3 grid. The host gate measures foreign CPU as whole-host busy minus the cohort's own process
  tree over one shared window, still limited to 10%, and foreign build processes still refuse. An
  independent review of these changes found two blocking defects, both fixed before the final run:
  the own-CPU subtraction used a different window than the host reading, and the cross-sample
  reference advanced every sample so the world tolerance could compound (it now stays anchored to the
  first sample). The review also led to finite-number checks on world positions, position validation
  and a `probe` flag recorded in every report.
- An eighth attempt (`hover-9`) completed nine FZK samples and was refused before the tenth at 11.2%
  foreign CPU. See [`hover-attempt-8.json`](hover-attempt-8.json) and [raw samples](hover-9-runs.jsonl.gz).
- The cohort then intended as final (`hover-8`) completed all five pairs for FZK and for Building-Architecture with
  every gate satisfied, then aborted in Federation pair 1 (branch): one pick resolved a different
  entity at the same texel, at a world position within 0.22 mm on z (about 0.29 mm Euclidean) of the reference hit, consistent with
  coplanar surfaces z-fighting. Federation is therefore incomplete (one pair), the frozen cohort is
  not accepted, and no formal verdict exists. A post hoc table from the valid samples, clearly marked
  partial, is in [`hover-attempt-7.json`](hover-attempt-7.json); raw samples are in
  [`hover-8-runs.jsonl.gz`](hover-8-runs.jsonl.gz). Across the two completed scenarios the candidate
  maps 256 bytes instead of the full aligned depth copy per pick, GPU picker time is lower in every
  pair, and hover latency is lower in nine of ten pairs. Nothing here replaces the required Federation
  comparison or the frozen protocol; it is retained as non-conclusive evidence.
- Attempts 9 and 10 (`hover-10`, `hover-11`) never started: the first was cancelled while queued and
  the second hit the fleet's fixed one-hour admission limit behind another session's Pop job.
  Attempt 11 (`hover-12`) was refused in its second sample because the operator moved the physical
  mouse on the Pop display, injecting 15 extra pointer events that the input/pick pairing gate
  rejected. Attempt 12 (`hover-13`) was refused before its second sample by a single one-second
  reading of 11.35% foreign CPU, about one second after the first sample's browser closed, with no
  foreign build processes; Pop measured about 1.3% busy two minutes later. See
  [`hover-attempts-9-13.json`](hover-attempts-9-13.json), [`hover-12-runs.jsonl.gz`](hover-12-runs.jsonl.gz)
  and [`hover-13-runs.jsonl.gz`](hover-13-runs.jsonl.gz).
- Protocol change after observing attempt 12, not blinded: the pre-sample and post-sample host gates
  (`awaitQuietHost` in `pick-depth-6881-host.mjs`) repeat the same one-second foreign-CPU reading
  until one is quiet, for at most 60 seconds, and refuse only if none is. The 10% limit, the build,
  memory and AC conditions and the physical-console check are unchanged, and every reading is kept
  in the record. Only host readings are repeated; no timing sample is repeated, discarded or chosen.
  Sustained foreign work still refuses, while a transient spike now only delays the sample. The
  operator keeps the Pop mouse and keyboard untouched for the cohort.
- Attempt 13 (`hover-14`, with the bounded quiet wait; every host gate was quiet on its first
  reading) completed six FZK samples and was refused on the seventh by the identity gate: FZK grid
  point (0.7, 0.5) resolved coplanar entity 59553 instead of 37026, the same pair that stopped
  `hover-8` in Federation. Across all retained samples that point flips in both arms (base 5 of 26,
  branch 3 of 22), so it is a property of the model and canvas, not of either arm. See
  [`hover-14-runs.jsonl.gz`](hover-14-runs.jsonl.gz).
- Protocol change after observing attempt 13, not blinded: FZK uses the nine frozen Federation
  positions instead of the 3 x 3 grid ([`hover-configuration-3.json`](hover-configuration-3.json);
  Building-Architecture keeps the grid, stable in every retained sample). A dense 7 x 7 FZK probe
  (`probe-8`, 10 of 10 valid samples, no unstable position) confirms all nine are stable in FZK; see
  [`fzk-position-stability.json`](fzk-position-stability.json) and [raw samples](probe-8-runs.jsonl.gz).

## Hover verdict

Attempt 14 (`hover-15`, job `ef6524fb`, head `0a20f3c693`, configuration 3) completed all 30
samples (five interleaved base/branch pairs for each of FZK, Building-Architecture and Federation)
with every host, health, pairing, allocation and identity gate satisfied. Every host gate was quiet
on its first reading (largest foreign reading 8.39%), so the bounded quiet wait never engaged. Base
is the full-copy control; branch is the candidate.

| Scenario | Metric | Base median | Branch median | Paired ratio | Branch lower |
|---|---|---:|---:|---:|---:|
| FZK | pointer-to-hover median (ms) | 22.07 | 16.36 | 0.72 | 5 / 5 |
| FZK | pointer-to-hover p95 (ms) | 29.15 | 28.79 | 0.95 | 4 / 5 |
| FZK | GPU picker median (ms) | 19.28 | 12.41 | 0.63 | 5 / 5 |
| Building-Architecture | pointer-to-hover median (ms) | 19.07 | 13.93 | 0.73 | 5 / 5 |
| Building-Architecture | pointer-to-hover p95 (ms) | 22.85 | 15.91 | 0.74 | 5 / 5 |
| Building-Architecture | GPU picker median (ms) | 13.92 | 11.12 | 0.85 | 5 / 5 |
| Federation | pointer-to-hover median (ms) | 22.53 | 17.14 | 0.76 | 5 / 5 |
| Federation | pointer-to-hover p95 (ms) | 33.28 | 33.08 | 0.86 | 3 / 5 |
| Federation | GPU picker median (ms) | 20.16 | 14.30 | 0.71 | 5 / 5 |
| all three | mapped bytes per pick | 3,233,792 | 256 | 0 | 15 / 15 |

Verdict: accepted improvement in hover latency and GPU picker time on public models, with a
bounded 256-byte mapping per pick. With nine hovers per sample the p95 is the slowest hover, so it
is reported but not claimed. No loading-speed claim is made. The DPR tolerance, world tolerance and
its anchoring, own-process CPU subtraction, bounded quiet wait and probed pick positions were each
introduced after observing earlier attempts and are not blinded; every earlier refusal above is
retained and no sample was replaced. Per-pair values: [`hover-verdict.json`](hover-verdict.json);
raw samples and report: [`hover-15-runs.jsonl.gz`](hover-15-runs.jsonl.gz),
[`hover-15-result.json.gz`](hover-15-result.json.gz).

[Preparation receipts](preparation.json) retain command/source identities,
original outcomes and log hashes. Failed functional reports and compact summaries
are retained as `functional-service-{1,2,3}.json.gz` and matching summary files;
none is promoted to an acceptance result.

## Accepted functional result

Chrome 156 on the physical Pop console positively identified NVIDIA Lovelace at
DPR 1 and 2, with no page, uncaptured-device or GPU-driver errors. At each DPR,
26 single-model and 35 federation samples matched the independent full-depth
and ID copies from the same submitted render exactly, including decoded model,
item and world position. Nine authored-family comparisons at each DPR also
matched, for 140 successful comparisons in total. The corrupted-depth inverse
rejected at both DPRs.

That accepted run used an earlier revision of `pick-depth-6881-observer.mjs` (`d14ac6c6`); the
observer was later changed to count destroyed oracle buffers before clearing them (`4325ce90`).
The qualification was rerun on the harness committed here (job `d48bcdb1`, same build, fixtures
and controls) and again passed all 140 comparisons, with the inverse rejected at both DPRs; see
[`functional-current-harness-summary.json`](functional-current-harness-summary.json) and
[the report](functional-current-harness.json.gz).

Both federated models supplied isolated flat-mesh ownership hits. Complete
geometry fingerprints stayed identical before and after picking. Camera and
resize changes rejected both held results at each DPR; device loss did so at
DPR2. Each of the six tracked transient buffers was destroyed exactly once per
lifecycle case. The raster fixture passed its existing mesh, texture, instance,
point, line, highlight, shadow, clipping and large-origin checks at both DPRs.
The large-origin case is authored geometry; real georeferenced IFC data is not
claimed by this cohort.

The actual viewer screenshots show the fully loaded two-model state:
[DPR1](federation-dpr1.png), [DPR2](federation-dpr2.png).

## Functional protocol

Run [the native controller](../../e2e/pick-depth-6881-native.mjs) under registered
service admission with a successful original build receipt and a new output
directory. It uses the retained Linux physical-console browser workflow from
#6709, a 1440 × 900 CSS viewport and controlled DPR 1 and 2. Collapse the sidebar
through its normal UI before the first load, as required by that workflow's
documented location-map driver diagnostic.

Load the catalogued public FZK fixture through Open, then add the catalogued
buildingSMART architecture fixture through Add. Require authoritative metadata,
geometry and primary scene-finalization completion; Add requires a completed
load root and resident per-model GPU batches. The
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

<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# Same-job production viewer comparison (#6537)

This is a prospective evidence protocol, with no recorded performance verdict.
The dispatch-only `perf-interleaved.yml` workflow compares two immutable source
commits in one GitHub-hosted Ubuntu 24.04 job. It does not use the committed
benchmark baseline. It does not authorize, publish or merge the candidate.

Supply `base_ref` and `candidate_ref` as distinct lowercase 40-hex commit IDs.
Moving branches/tags and abbreviated IDs are refused before either checkout.
The harness itself comes from the dispatch's recorded `github.sha`.

Both revisions have isolated dependency graphs and Cargo target directories.
The pinned WASM setup action must match on both sides. Root Turbo builds each
production viewer with `--force`, including its source WASM build. Both builds
finish before the frozen inventories, servers and timed cohort start. There is
no prebuilt eligibility path. Fresh WASM timestamps, matching served asset
hashes, clean tracked source, source tree IDs, lockfiles, fixture bytes and
toolchain/runtime versions are recorded. Viewer/fixture inventories are checked
again after measurement. Frozen servers use no-store responses with COOP/COEP
so the default isolated SharedArrayBuffer path remains available.

## Fixed schedule and bounds

Exactly four manifest-backed public IFCs are requested: AC20-FZK-Haus,
ISSUE_129, Holter Tower (ISSUE_053), and O-S1 architecture. Their exact byte
sizes, SHA-256s and public release provenance come from the harness revision's
`tests/models/manifest.json`. Missing/mismatched input stops setup. No file is
replaced by a smaller file or synthetic input.

Each fixture has one two-sample baseline A/A control followed by five paired
comparisons in A/B, B/A, A/B, B/A, A/B order: 48 samples total. Every sample
launches a fresh Chrome process and context, and loads its target as the first
file through the viewer's canonical file input. There are no URL feature knobs
or benchmark environment overrides. Worker count/IDs, SAB/isolation and sharded
prepass logs are recorded. Overrides, missing census, incomplete readiness,
changed output, failed teardown or unsupported identity stop the finite cohort.
No sample is retried or replaced. An A/A full-readiness difference above 10%
also stops the cohort; one pair is a noise screen, not a noise distribution.

Load timeouts are 180 seconds for Haus, 300 for ISSUE_129 and 600 for Holter/O-S1.
Post-readiness identity has 120 seconds, teardown 30 seconds, measurement a
90-minute ceiling, and the whole job 150 minutes. The identity walk has a
24-level/8-million-node budget, 64 MiB per hashed buffer, and 2 GiB of total
hashed bytes. Crossing any bound is a refusal, not a truncated success.

The harness samples its own sample process and descendant tree's Linux RSS
every 250 ms, with a 5 GiB ceiling. Samples and before/after `/proc/loadavg`
are retained. Summed RSS may count shared pages repeatedly, and sampling misses
short-lived peaks. It is not physical peak memory, WASM linear-memory peak, or
GPU allocation peak. The report separates samples before first readiness from
post-readiness hashing/capture. Only owned sample process groups are terminated.

Runner logs are awaited through stream completion. Witnessed descendants are
fenced by Linux PID/start-time and drained within a shared 30-second cleanup
budget; receipts disclose remaining live processes and zombies. A forced pipe
close is refused because its unreachable tail cannot be certified lossless.
Both servers close in parallel within 30 seconds, destroying only their tracked
sockets on timeout. The report is saved before server close and rewritten with
shutdown receipts. Pending shutdown never presents as a complete cohort.

## Completion and exact identity

Timing uses the existing strict benchmark readiness helper: metadata complete,
geometry complete, renderer finalize complete, and an allocated canvas. This
is a console/polling boundary with 100 ms polling granularity; canvas allocation
alone does not establish visible pixels. The timestamp and parsed load/stream/
metadata/parse metrics are frozen before identity/property reads and images.
After that boundary the model must be complete, global loading/streaming must
be settled, and no model or page error may be present. The property table must
be available; a real authored property owner is read when properties exist.
Its witness/counts and actual phase fields are retained, including null/idle
phase fields. They are not silently upgraded to a stronger readiness claim.

Identity is deliberately specific to the reviewed private renderer shape.
A bounded, read-only canvas React-fiber/hook walk finds its live Renderer ref
after timing. Retained flat meshes are hashed as a sorted multiset, preserving
duplicates and their exact typed-array bytes, IDs, colors/shading colors,
origins, item/material ownership, authored metallic/roughness, canonical
appearance indices, local bounds/placements and geometry hashes/AABBs/volumes.
Unknown mesh/material fields refuse. UVs, embedded/external textures, decoded
bitmaps, point clouds and authored `IfcText*` types refuse; this protocol does
not establish their appearance identity.

For instances, `instancedTemplateCpu` and `instancedEntityMap` must expose the
reviewed shapes. Template positions/normals/indices and local bounds are hashed
as raw bytes. Each owner's record includes its template digest, exact 88-byte
packed matrix/owner/color/flags, f64 canonical anchor, f32 canonical matrix
translation, original color, representation item ID and finish bits. Raw
colors/finish flags establish these retained shader-input channels, not all
original IFC style attribution. Every occurrence must have exactly one record;
every retained template must be owned; packed IDs, per-template coverage,
scene owner IDs and GPU instance occurrence counts must agree. Pointer offsets,
template ordinals and publication order are excluded from the sorted multiset.
Private shape changes or released/incomplete geometry refuse. Coordinate info
and instanced geometry hash/AABB/volume side channels are also included.

The reviewed primary loader sets bounded geometry mode false, and the viewport
passes `releaseGeometryAfterStream=false`. Scene vertex release is conditional
on that opt-in path. The default 3072 MiB host budget evicts CPU buckets only
with a cold restore provider; fresh primary loading clears that provider, which
cache-hit loading alone installs. None of the four fixture sizes forces CPU
release on this first-file path. This is source eligibility, not observed
acceptance: positive flat/template buffers and the Scene release flag are
checked after readiness. Unsupported appearance or any original work/memory/
time bound can still refuse a real fixture.

SHA-256s are compared within A/A and every A/B pair. They prove identity only
for the listed retained CPU channels. They do not prove producer-internal
diagnostics, metadata values beyond the recorded property witness, GPU buffer
byte identity, precision of unretained IFC attribution, or pixel identity.
Full raw console/page errors, observed WASM response URLs/statuses and frozen
server asset hashes accompany each run. Render stats and renderer-owned color
frames are captured after timing when available. The response URLs/statuses
are original load observations; server inventories are the source byte witness,
not copies of original response bodies.

## Interpreting the artifact

`protocol.json` and `schedule.json` preserve the planned inputs/order;
`provenance.json` preserves builds/runtime/fixtures. Each sample has input,
result, runner log, sampled RSS and any color frame. A child writes its result
before teardown. Timeouts and missing child results receive explicit terminal
rows. `samples.jsonl`, `report.json` and `report.md` retain completed and refused
work. Build/setup failures upload the available protocol/diagnostics and carry
no timing verdict. All old failed cohorts remain independent evidence.

Only a complete twelve-sample family gets paired medians/ranges; unavailable
phase metrics remain unavailable. Earlier complete families may be described
after a later refusal, while the entire cohort remains refused/incomplete.
These are descriptive changes, not confidence intervals or an automatic
speedup decision. No universal corpus claim is made. The environment is
headless Chrome with SwiftShader: any verdict is about CPU worker-pool/full
readiness there. Native GPU rendering benefit and interactive FPS remain
unclaimed. Record any eventual measured verdict and lesson in the performance
ledger only after an independently reviewed actual cohort.

The root `typecheck:perf-interleaved` script runs the explicit no-emit
`scripts/perf/tsconfig.interleaved.json` program, wired in this workflow. It
covers the sample, input/result/callback declarations and the reused benchmark
helpers without workspace sibling `dist` dependencies. Runtime configuration
parsing starts from `unknown`; private-shape JavaScript behavior is covered by
the wired invariants. This source-only change records no executed validation
or performance verdict.

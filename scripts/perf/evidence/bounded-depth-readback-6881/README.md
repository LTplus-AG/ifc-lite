# Bounded GPU point-pick depth candidate (#6881)

Status: candidate held for qualification. These hardware runs prove a bounded
mechanism and several correctness invariants; they do not establish a viewer
hover speedup or satisfy every acceptance condition of #6881.

## Current-main CPU qualification, 2026-10-09

The isolated integration at `011a235d538d3cda5625e32c2d0a830f61dfcc9b`
includes main `29a1648b3ea56a346012b65ab3b7e41ecd598e8f` and the existing
cleanup repair. The earlier prepared merge retained both the #6881 refusal
and main's unrelated #6993 ledger entry; the subsequent main merge was clean.
No additional picking implementation or hypothesis-driven fix was added.

Root Turbo renderer tests pass: 2,058 passed, zero failed, two existing skips.
All ten cleanup fault controls pass without skips. The omitted tests remain
the opt-in 340 MB memoization stress test and real WebGPU packed-origin
readback unavailable in Node. These controls qualify allocation and resource
ownership invariants, not actual GPU picking or a performance result.

Full root `pnpm typecheck` passes, including all 3,862 test files in 62 packages,
the root test-program audit and `scripts/perf/tsconfig.frames.json` postcheck.
The actual native Turbo processes were independently inspected with
`--concurrency=1`; renderer tests used two-CPU affinity and bounded concurrency.
Temporary package scripts were restored byte for byte. Root lint and the
module-size, test-wiring, source-assertion, CI-path, license-header,
changeset-bump, API-surface and candidate whitespace gates pass. API surface
matches 55 packages, 95 surfaces and 9,597 exports. Existing lint warnings
remain in the full report; there are no lint errors.

`main-integration-cpu-20261009.json.gz` preserves exact commands, complete logs,
source/runtime manifests, host conditions and terminal/restoration receipts.
Before and after tracked source manifests match. The initial acquisition
parser refusal and the command-verifier's erroneous launcher match are also
retained with their corrections and independent native-process proofs.
The retained real FZK file is hashed again without loading it. No browser,
server, model comparison or GPU/performance cohort ran under this CPU grant.
The earlier runtime pair and hardware evidence retain their original source
pins; they do not qualify this new integration's GPU behavior.

Verdict: **CPU integration qualified; NOT READY; retain draft.** Current-source
real-model base/candidate serial/overlap and coordinate/lifecycle comparisons,
second fixture/federation, unexplained historical XYZ differences, focused
physical browser performance, required review and current-head CI remain open.
The original browser coordinates and refusal deadlines are unchanged.
Full local evidence and the eventual matching lane-release receipt are under
`/home/louistrue/.t3/artifacts/6881-qualification-48637c43-20261009/main-integration-cpu-20261009`.

## Cleanup qualification, 2026-10-09

The campaign's existing cleanup repair and ten fault controls were adopted into
an independent Linux checkout at published head `ac5e1ad39`. Point ID copying
and the entire rectangle readback now run inside the existing resource-release
boundary. Both paths use `releaseReadbacks`; no coordinate or ownership
calculation was added. Five controls fail with the published cleanup code
(point ID copy; rectangle ID copy, finish, submission and mapped-range access).
All ten pass with the repair. These injected faults prove buffer ownership,
not actual GPU picking or a performance improvement.

`cleanup-qualification-20261009.json.gz` preserves full logs, exact commands,
source hashes and terminal/restoration receipts. Root Turbo typecheck passed,
including the audit of all 3,693 test files in 62 packages. Root renderer tests
passed 2,078 tests, with zero failures and two skips: the opt-in 340 MB stress
test and real WebGPU packed-origin test unavailable in Node. Root lint,
test wiring, source-assertion and module-size checks passed. The initial
module-size failure against a stale local main is retained; the check passes
against the fetched GitHub main's actual merge base `e60ed32ee`. Picker's
allowlist budget was lowered to its measured 708 lines.

The prior FZK attempt's 1,000 ms animation-frame refusal is preserved under
`/home/louistrue/.t3/artifacts/6881-fzk-overlap-recovery-plan-20261009`.
It produced no declared serial/overlap comparisons and proves neither a picking
defect nor acceptance. Current GPU comparison, real federation and focused
physical performance remain unqualified. Keep this PR in draft.

## Source-matched admission refusal, 2026-10-09

Both root viewer builds passed, including the chunk-await postcheck, before
the new candidate admission. The optimization's original parent
`e60ed32ee7299839cdce76e4a5c907ab0f1d4266` is the comparison base; the candidate
runtime is from cleanup commit `b5840a84f7cf402a28fd3f26a873b3ea9b0b0a4e`.
Full source and runtime manifests are retained. Their Rust trees, lockfiles,
WASM build scripts and actual WASM bytes match. The ten-input diagnostic helper
was rebuilt against this candidate's canonical helpers, without constructing a
second Renderer or adding a load path. Seven HTTP admission reads matched the
pinned Renderer, main, helper, HTML, provenance, FZK and WASM bytes.

The one allowed T3 navigation timed out after 15,000 ms. Inspection returned
`about:blank`, with no diagnostic boot or phase in that inspected context.
The server received asset requests after the timeout; these do not establish a
successful application boot or model load. No model phase was invoked by the
agent, and no actual serial/overlap, picked identity/depth/XYZ, loaded geometry
hash, or GPU adapter certificate was obtained. No retry, point search or
deadline extension followed. Base picking and the expanded cohorts remain
unrun. This setup refusal is separate from the retained historical RAF refusal;
neither proves a picking defect or completes acceptance.

The owned server (PID 56757, start ticks 1789452, port 5431, exec session 33693)
received SIGTERM after identity verification, exited 0, and had both PID and
listener absence checked independently. The owned tab was inspected blank.
Separate explicit cleanup navigation/open calls failed on the preview client,
so app/device/tap/listener retirement is not inferred. The terminal tool reported
truncated HTTP stdout; its exact reported excerpt and truncation are retained,
without claiming a complete request transcript. Shared tabs, servers, the
campaign integration checkout and historical evidence were preserved.

`qualification-attempt-20261009.json.gz` preserves full build logs, source/runtime
and model pins, the finite plan, raw browser tool refusals/inspections, and exact
owned cleanup receipts. Frozen runtimes and full source manifests remain under
`/home/louistrue/.t3/artifacts/6881-qualification-48637c43-20261009/execution`.

| Contract | Independent qualification | Current-source real-model requirement |
| --- | --- | --- |
| CSS offsets, device pixels and HiDPI | Canonical viewport/drawing-buffer helpers reviewed; root manager tests passed | Untimed DPR 2 admission observed; actual picking cohort unrun |
| Edge texels and resize | Point picker's single floor/clamp and canonical texel-center unprojection reviewed; root controls passed; historical GPU corner/resize evidence retained | Real-model edge/resize controls unrun |
| Format, mip/sample and alignment | Single-sample depth32float, mip 0; ID byte 0/depth byte 4; 256-byte staging plus 8-byte coordinates/4-byte result reviewed and tested | New actual GPU encode/map validation unqualified |
| Asynchronous ordering and overlap | Per-call immutable resources and one submission/map reviewed; ten failure controls qualify ownership | Serial 2/held-delivery overlap 2 comparisons unrun |
| Navigation and stale results | Canonical manager viewport/RTE guards passed root controls; reference-selection cancellation reviewed in source | Current GPU navigation/cancellation unrun; tooltip ordering remains a source hypothesis |
| Device loss and destruction | Root abort/fault/disposal controls passed; historical real-device evidence retained | New actual loss/teardown unqualified; direct-Picker destruction remains a source hypothesis |
| Single/federated ownership | Canonical decoding and store-backed model resolver reviewed; no offset calculation added | Current single-model certificate, real federation and second fixture unqualified |

Verdict: **NOT READY; retain draft.** Focused physical browser performance remains
unavailable and unqualified. Required review and current-head CI,
unexplained historical XYZ differences and all missing
real-model controls remain requirements. No hover or load speedup is claimed.

The prior cleanup cohort's final API-surface check matches 55 packages, 95 export surfaces and 9,569
exports. Its initial missing-declaration refusal is retained; a bounded root
Turbo build supplied the five missing package declarations before rechecking.
The standard module-size check also passes after the isolated clone's origin
was set to GitHub main. Git objects were copied into this clone's Linux object
store, its Windows alternate removed, and connectivity verified. No foreign
Git metadata changed. The campaign heavy lane was released after all owned
heavy jobs and the server terminated.

The candidate dispatches one depth-texture `textureLoad` after the unchanged pick
render and copies the resulting f32 into byte 4 of that pick's ID staging buffer.
Render, compute and copies share one command submission. Every call owns its
immutable coordinate buffer, storage output and staging buffer through mapping.
Transient point-pick buffer allocation is 268 bytes (256 + 8 + 4), independent of
target dimensions; the full render targets and uniform buffers still exist.
The oracle's separate compute-only staging is eight bytes, so its `boundedBytes`
field reports twenty bytes; it is not the production pick's total allocation.

## Retained actual-GPU evidence

`native-oracles.json` was captured through the T3 collaborative browser on the
reported NVIDIA Blackwell adapter. The exact browser version is in `userAgent`.
The compiled harness executes the production helper and production Picker; the
full-depth copy is test instrumentation in the same render submission.

- Twelve samples, including corners and interior texels, at 4×4, 67×19 and
  1292×1047 match the full-depth-copy oracle bit-for-bit. Maps overlap while
  textures are destroyed and replaced after submission. No GPU errors occurred.
- The production flat-mesh picker retains entity 123, model 7 and item 456.
  Its worldXYZ matches full-depth unprojection exactly at a 5,000 km source
  origin. Calls cover negative/outside border coordinates, target resizing,
  a crop which removes the hit, and a camera mutation during pending maps.
- Destroying the actual GPU device while two point picks are pending resolves
  both to null. No second production readback pipeline is retained.

The flat mesh is a stated raster/unprojection invariant, not an IFC model.
Federation metadata is retained; this does not replace a real federated viewer
load or establish manager-level stale-camera rejection (covered by the existing
manager tests).

## Reproduction

Build/bundle `tests/e2e/pick-depth-readback-6881.manual.mjs` as an ES module with
esbuild (the pinned viewer/tsx toolchain includes esbuild), serve the output on a
loopback HTTP server, and import it in an actual WebGPU browser:

```js
const m = await import('/qualification.js');
const report = {
  depth: await m.runDepthOracle(),
  picker: await m.runPickerOracle(),
  deviceLoss: await m.runDeviceLossOracle(),
  userAgent: navigator.userAgent,
};
```

The harness throws on depth, ID/item/model/worldXYZ mismatch or unexpected GPU
errors. Both oracle functions free temporary resources. The renderer's existing
lifecycle suite also exercises aborted/faulting maps and requires bounded
transient allocation and cleanup at small and large viewports.

## Required before shipment

Complete real public IFC/federated viewer interactions. Run baseline/candidate hover A/B
in interleaved fresh sessions after complete loads, with actual output identity,
allocation evidence, and an otherwise-idle host. Keep all samples, including
failures. Assess end-to-end interaction timings; an extraction microbenchmark
cannot stand in for them. The retained public-model timings below are inconclusive and do not complete acceptance.

## Renderer-family controls and witness correction

The original production-route failure is retained in
`production-witness-before-harness-fix.json.gz`. It sampled CSS coordinates as
physical PNG coordinates at native DPR 1.5, and the canvas border changed the ray
viewport relative to the snap projection. Correcting the screenshot conversion
and removing that canvas border preserves the intended geometric/pixel tests.
The E2E framebuffer-size assertion now accounts for the renderer's density cap.

`renderer-base-density-controls.json.gz` runs the exact archived base renderer
against the corrected witness. `renderer-density-controls.json.gz` runs the
candidate. Both pass every named production family at controlled density inputs
1, 1.5 and 2, with no GPU errors; the native browser density is explicitly 1.5.
These are real hardware framebuffers at those densities, not three different
physical displays. Source and bundle hashes are in `functional-build-receipt.json`.
The small esbuild harness imports the actual production Renderer and existing
witness; it does not create another rendering implementation.

`renderer-same-render-oracles.json.gz` additionally appends a test-only full-depth
copy to each candidate pick submission. All 27 samples are bit-identical. Each
sample records its encoded ID and density; the existing witness separately checks
flat/textured model and item provenance, instanced and point IDs, cropped/sectioned
no-hit results, georeferenced/large-extent coordinates, snaps and measurements.
The instrumentation changes texture COPY_SRC usage and observes mapped bytes
only in the manual harness. No runtime full-depth fallback exists.

One initial development-route attempt produced swapchain/device mismatch errors;
the original production build cleared those errors. A subsequent full viewer
build for the corrected witness was killed with exit 137 under shared-host
memory pressure. Neither attempt is accepted timing evidence. Both corrected-harness root viewer builds subsequently completed successfully. Their frozen distributions and fixture hashes are recorded in `viewer-build-receipt.json.gz`.

## Public IFC hover A/B, still held

`public-ifc-hover-ab.json.gz` retains four complete alternating-order pairs and
the fifth pair's failed browser attempt. `public-ifc-hover-expressions.json`
contains the exact evaluated setup, readiness and pointer-handler probes. Each
complete session used a fresh document, cleared IndexedDB, uploaded the same
public FZK fixture through its file input, and waited for parser completion,
geometry completion, scene finalization and an allocated viewport. No adapter
request preceded the upload. Native DPR was 1.5. Each of nine predeclared pointer
positions passed through the actual tooltip hover handler at 300 ms spacing.

All eight complete sessions produced the same 275 meshes, 56,698 vertices and
32,852 triangles and ordered position/normal/index FNV-1a `f88bafa4`. All 72
positions agree on hit IDs and model provenance, including 24 misses. Three pairs
agreed exactly on worldXYZ; the fourth baseline session's six hits differed by
up to 0.000647553 metres. No camera matrix or rendered-frame identity was captured
for those sessions, so the cause remains unknown and this is NOT accepted
coordinate equivalence. A new paired run must retain a common settled camera,
viewport and same-frame depth/matrix receipts. The same-submission functional
oracle above continues to pass independently.

Every baseline hover mapped 256 ID bytes plus 1,975,296 depth bytes; every candidate
hover mapped only 256 shared staging bytes. Device buffer allocation instrumentation
was shadowed by the load tracer, so mapped sizes are measured here while total
268-byte allocation is the separately tested invariant. Input-to-hit-store median
latencies are retained in `public-ifc-hover-summary.json`; their signs are mixed.
There is no demonstrated hover speedup. Other agents stopped expensive work, but
OS CPU admission snapshots were not collected, so coordination alone does not
prove complete host idleness. No throughput verdict is accepted.

The fifth readiness call lost T3 automation. Status/open briefly recovered the
same tab, then evaluate timed out after 15 seconds and open explicitly reported
that no automation host was available and instructed against retrying. The failure
is retained; no replacement software GPU measurement was made. Real federated
viewer hover and a second public model remain unqualified. Keep the PR in draft.

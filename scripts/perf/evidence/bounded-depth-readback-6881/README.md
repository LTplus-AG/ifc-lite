# Bounded GPU point-pick depth candidate (#6881)

Status: candidate held for qualification. These hardware runs prove a bounded
mechanism and several correctness invariants; they do not establish a viewer
hover speedup or satisfy every acceptance condition of #6881.

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
memory pressure. Neither attempt is accepted timing evidence. Both corrected-harness root viewer builds subsequently completed successfully. Their frozen distributions and fixture hashes are recorded in `viewer-build-receipt.json`.

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

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

Complete same-render production evidence for instanced geometry and points, plus
real public IFC/federated viewer interactions. Run baseline/candidate hover A/B
in interleaved fresh sessions after complete loads, with actual output identity,
allocation evidence, and an otherwise-idle host. Keep all samples, including
failures. Assess end-to-end interaction timings; an extraction microbenchmark
cannot stand in for them. This evidence contains no timing measurements.

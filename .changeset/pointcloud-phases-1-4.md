---
"@ifc-lite/pointcloud": minor
"@ifc-lite/renderer": minor
"@ifc-lite/viewer": minor
---

Phases 1–4 of point cloud loading.

- **LAS streaming** (`.las` files) — header parser + per-point record decoder
  for ASPRS Point Data Formats 0–10, with auto-detection of "8-bit RGB
  in u16 channels" producers and on-the-fly rescaling.
- **LAZ streaming** (`.laz` files) — wraps `laz-perf` (Apache-2.0) as a
  runtime dep, decoded inside a Web Worker so the main thread stays
  responsive.
- **Streaming pipeline** — Blob-backed byte source, decode worker with a
  postMessage protocol that ships chunks back as transferable typed-array
  buffers, host-side controller that paces decode, applies a 25M-point
  memory cap with stride downsampling, and reports progress / completion.
- **Renderer streaming API** — `Renderer.beginPointCloudStream`,
  `appendPointCloudChunk`, `endPointCloudStream`, `removePointCloudAsset`,
  `setPointCloudOptions`. Streamed assets coexist with IFCx-derived
  assets in separate ownership buckets so `setPointClouds` doesn't clobber
  active streams.
- **Color modes** — `rgb` / `classification` (ASPRS palette) / `intensity` /
  `height` (cool-warm ramp) / `fixed`. Per-point classification + intensity
  travel through the GPU vertex layout and the WGSL shader picks the
  channel based on the active mode uniform.
- **Viewer integration** — file picker accepts `.las,.laz` (browser drop +
  native dialog), a small bottom-left panel exposes the color modes when
  point clouds are loaded, and the federation registry's `modelIndex`
  flows through streaming ingest for multi-model picking parity.

GPU-based point picking is deferred to a follow-up; clicks on points
return null and don't crash existing mesh selection.

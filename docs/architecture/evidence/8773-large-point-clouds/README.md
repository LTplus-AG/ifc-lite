<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# Point clouds larger than 4 GB (#8773)

`streamPointCloud` used to refuse every point cloud over 4 GB. It now applies that
default only to formats whose source reads the whole file (PCD, PTS, XYZ, LAZ).
E57, PLY and LAS stream from bounded windows and have no default ceiling. LAS
strided reads are split into reads of at most 16 MiB.

## Browser

These captures come from the production viewer build (`vite build`, served by
`vite preview`) in Windows Chrome 156 on a real GPU (WebGPU), driven over CDP by
[`browser-load.mjs`](browser-load.mjs). The file is handed to the viewer's own
file input with `DOM.setFileInputFiles` and a native path, so nothing is
uploaded over CDP.

| File | Size | Result |
| --- | --- | --- |
| Synthetic LAS, format 2, 180,000,000 points ([`generate.mjs`](generate.mjs)) | 4.68 GB | 22,500,000 points at stride 8 in 8.3 s: [streaming](las-4p7gb-streaming.png), [loaded](las-4p7gb-loaded.png) |
| Registered terrestrial-laser E57 scan, 427,969,069 points (private, not published) | 13.33 GB | 23,776,060 points at stride 18 in 42 s, rendered in full |

Before this change, both files were refused up front with `Point cloud rejected:
file is … MB, exceeds maxFileSize 4295 MB`.

## Sources through `streamPointCloud`

[`host-run.mts`](host-run.mts) drives `streamPointCloud` with default options and
the real in-process sources. It samples `process.memoryUsage().arrayBuffers`
every 5 ms and FNV-1a hashes every emitted position and colour byte. Node's
`fs.openAsBlob` reports sizes past 2^32 modulo 2^32, so the script uses a small
fs-backed `Blob` stand-in that provides `size`, `slice` and `arrayBuffer`.

| File | Size | Stride | Emitted | Time | Peak `arrayBuffers` |
| --- | --- | --- | --- | --- | --- |
| E57 scan above | 13.33 GB | 18 | 23,776,060 | 80 s | 83 MiB |
| Synthetic LAS above | 4.68 GB | 8 | 22,500,000 | 2–6 s (page-cached) | 81–85 MiB |
| Synthetic binary PLY, 300,000,000 points | 4.50 GB | 12 | 25,000,000 | 57 s | 74 MiB |

On the synthetic LAS, the previous single-slab LAS reader (run with
`maxFileSize: Infinity`) and the windowed one emit identical output: FNV
`4e133781` for both, the same 113 chunks and the same bounds. At this size their
peak memory is within noise, because the previous slab was 41.6 MB at stride 8.
The window only matters at larger strides, where the previous slab grows with
the file and the new read stays at 16 MiB. `las-source.test.ts` pins that bound.

## Reproduce

```sh
node docs/architecture/evidence/8773-large-point-clouds/generate.mjs las /tmp/big.las 180000000
node docs/architecture/evidence/8773-large-point-clouds/generate.mjs ply /tmp/big.ply 300000000
pnpm exec tsx docs/architecture/evidence/8773-large-point-clouds/host-run.mts las /tmp/big.las
pnpm exec tsx docs/architecture/evidence/8773-large-point-clouds/host-run.mts ply /tmp/big.ply
```

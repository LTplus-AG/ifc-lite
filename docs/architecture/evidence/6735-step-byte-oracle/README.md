# #6735: whole STEP byte assertion

The [failed Node job](https://github.com/LTplus-AG/ifc-lite/actions/runs/37065208613/job/111033735405) timed out the real MiniBIM export oracle. The [matching main job](https://github.com/LTplus-AG/ifc-lite/actions/runs/37063430052/job/111027497399) passed with the same fixture test source. `diagnosis.json` records those contexts, catalogue fixture hashes, actual fresh WASM provenance, two unchanged-oracle diagnostic controls, stage results and retained raw-trace hashes.

The second control separated repeated export from the generic deep matcher. Its dominant stage was full multi-megabyte `Uint8Array.toEqual`, after canonical geometry and all sampled surface checks had completed. These are correctness-stage diagnostics under host load. They establish a test-harness cost; they are not an end-to-end browser or worker-pool performance verdict.

The correction uses [`Buffer.compare`](https://nodejs.org/api/buffer.html#static-method-buffercomparebuf1-buf2) on the complete two `Uint8Array` values. A zero result requires equal length and every byte equal; nothing is decoded, hashed, sampled or omitted. The private test assertion is exercised against actual repeated Haus and MiniBIM exports, then the same assertion must reject first-, middle- and last-byte perturbations and a shortened identical prefix. Product, placement, CRS, type, style and surface assertions, fixed export timestamp, fixture policy and the existing deadline remain unchanged.

Correction runtime qualification is pending. No timeout increase, model downsampling or product export/geometry optimization is part of this fix. Original traces and the diagnostics remain retained independently of the correction.

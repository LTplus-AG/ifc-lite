<!-- perf-ratchet-report -->

### Perf ratchet: all metrics within their ceilings

Measured at `b133b0a2cb9faeda4851ca8c8c597d15d5875eff`.

| Metric | Ceiling | Tolerance | Allowed | Measured | Change vs ceiling | Status |
| --- | ---: | :---: | ---: | ---: | ---: | --- |
| `bundle/engine-wasm-brotli` (bytes) | 2,221,156 | +0.50% | 2,232,261 | 2,220,297 | -859 (-0.04%) | improved |
| `bundle/viewer-entry-js-bytes` (bytes) | 4,362,788 | +0.10% | 4,367,150 | 4,209,116 | -153,672 (-3.52%) | improved |
| `bundle/viewer-eager-js-bytes` (bytes) | 19,694,667 | +0.10% | 19,714,361 | 19,207,400 | -487,267 (-2.47%) | improved |

0 other metric(s) unchanged.

3 metric(s) improved. 2 of them cleared the tolerance band, so the daily lowering job (`perf-ratchet-lower.yml`) will lower their ceilings once this is on `main`.

Informational, not gated:
- `bundle/viewer-entry-js-brotli`: 949,915 bytes (main-BZx1T6dC.js)
- `bundle/viewer-eager-js-brotli`: 3,104,977 bytes (212 files, each compressed on its own)

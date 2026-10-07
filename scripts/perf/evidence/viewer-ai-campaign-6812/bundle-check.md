<!-- perf-ratchet-report -->

### Perf ratchet: all metrics within their ceilings

Measured at `103c37c7f19a7d8e57681e32925d5fbab7e898d7`.

| Metric | Ceiling | Tolerance | Allowed | Measured | Change vs ceiling | Status |
| --- | ---: | :---: | ---: | ---: | ---: | --- |
| `bundle/engine-wasm-brotli` (bytes) | 2,221,156 | +0.50% | 2,232,261 | 2,220,297 | -859 (-0.04%) | improved |
| `bundle/viewer-entry-js-bytes` (bytes) | 4,362,788 | +0.10% | 4,367,150 | 4,209,112 | -153,676 (-3.52%) | improved |
| `bundle/viewer-eager-js-bytes` (bytes) | 19,694,667 | +0.10% | 19,714,361 | 19,208,940 | -485,727 (-2.47%) | improved |

0 other metric(s) unchanged.

3 metric(s) improved. 2 of them cleared the tolerance band, so the daily lowering job (`perf-ratchet-lower.yml`) will lower their ceilings once this is on `main`.

Informational, not gated:
- `bundle/viewer-entry-js-brotli`: 950,418 bytes (main-EvKOpIn-.js)
- `bundle/viewer-eager-js-brotli`: 3,105,777 bytes (212 files, each compressed on its own)

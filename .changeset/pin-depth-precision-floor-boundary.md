---
"@ifc-lite/clash": patch
---

Pin the `depthClashResult` f32-precision-floor comparison (`<=` at `engine-ts/depth.ts:195`) with a fixture whose box-box MTD lands exactly on the computed floor value, found by mutation testing (flipping the operator killed zero tests — the nearest existing fixtures sit a decade below and well above the boundary). No production logic changed — this is coverage-only, ported 1:1 from the equivalent Rust pin in `rust/clash/src/kernel_tests.rs`.

---
"@ifc-lite/wasm": patch
---

Validate analytic prism cuts with host-frame partition conservation and geometric contact bounds instead of treating open fragments as closed solids. Defer consolidated no-ops before refinement can turn them into a spurious cut. Check the final audited result against independent cutter and host volume bounds with local mesh quantization tolerance.

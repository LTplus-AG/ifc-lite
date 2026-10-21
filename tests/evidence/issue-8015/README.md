# Selective clipping browser evidence (#8015)

Captured from production renderer source at `bf030bb18aa98249c5739cc0156b078911740965` on 2026-10-21.
The strict Playwright witness completed all 36 cases on a native Intel gen-12lp WebGPU adapter: no skips, GPU errors, colour/pick/raycast mismatches, or shadow-depth mismatches.

`selective-clipping-report.json` is the unmodified witness attachment. `selective-clipping.png` is its canvas screenshot for `batched/first-whole`: two entities share a colour batch; the left entity is excluded and stays whole, while the right is cut by the primary and extra planes.

The witness exercises batched, instanced, wide-ID instanced, and individual draws across nine states each. It compares six analytical samples per state in colour pixels, GPU picks and CPU rays. Actual shadow-map depth texels are checked in every state except hidden, whose visibility partition is checked through the renderer probes.

Run `pnpm build --filter=@ifc-lite/renderer`, then the repository Playwright selective-clipping spec with `E2E_GPU_STRICT=1` on a native GPU. This capture used bundled Chromium, a headed 512-by-512 canvas, and `VK_DRIVER_FILES=/usr/share/vulkan/icd.d/intel_icd.json` to select the Intel adapter. Trace recording was disabled; the JSON reporter retained the attachments without additional browser screenshot sampling.

The local NVIDIA Vulkan backend failed with `VK_ERROR_OUT_OF_DEVICE_MEMORY` during shadow readback. A separate checkout of main at `f12729447e1fb8727daabea8df6736e845b9f15d` reproduced the same failure with the same geometry and baseline probe before any clipping transitions. It is not counted as a passing backend. Hosted SwiftShader device-loss skips are likewise not counted as verification.

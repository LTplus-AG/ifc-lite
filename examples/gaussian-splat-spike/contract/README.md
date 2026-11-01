# Native splat rendering contract: first counterexample

Tracking: [#8564](https://github.com/LTplus-AG/ifc-lite/issues/8564), part of [#8562](https://github.com/LTplus-AG/ifc-lite/issues/8562). Launch formats remain Gaussian PLY and `.splat`.

**Public enablement remains blocked.** This witness demonstrates that `SplatRenderer.drawMixed` cannot correctly compose transparent geometry between splats. It does not qualify the production viewer or complete the remaining rendering contract.

## Measured behavior

On upstream luma commit `700f1400fc6b0d32a82f1a22f57c1e747b255a01` with the depth-convention fix, render a near red Gaussian, a 50%-transparent green triangle at the intermediate depth, and a far blue Gaussian. The independent reference submits far splat, green triangle, near splat. The helper submits both sorted splats before the transparent triangle.

Center RGBA readback is `[189,33,24,255]` for the reference and `[94,128,24,255]` for `drawMixed`. The green triangle incorrectly covers the near red splat. The diagnostic test passes by asserting this counterexample; **exact composition fails**. Weighted transparency or sorting whole assets does not resolve this requirement.

Destroying the attached luma wrapper, then submitting a buffer clear through the original raw GPU device, succeeds without validation errors. This verifies borrowed-device survival for this isolated case.

The run used Chromium WebGPU with SwiftShader, not hardware performance qualification. The combined run passed 14 tests and skipped one existing configured-canvas reattachment test. The two depth readback tests and this diagnostic did not skip. Compact results and the original worker receipt ID are in `results.json`.

## Reproduce

Use the pinned upstream checkout with the depth-convention fix applied. Apply `mixed-transparency.patch` there, install using its pinned Node/Yarn versions, build, then run its documented browser harness:

```sh
CI=1 yarn test-headless --maxWorkers=2 --reporter=verbose modules/engine/test/splats/ifc-mixed-transparency.spec.ts
```

On the managed development fleet, execute through fleet admission and `ifc-gpu-check`. The patch is an external-harness diagnostic, not a test included by IFC-Lite's root test command.

## Remaining contract

A shared composition approach must preserve the rendered order of IFC glass/X-ray and Gaussian contributions; it needs adversarial intersection references before integration. Continue to reuse upstream Gaussian rendering. Do not enable a second standalone canvas as a production substitute.

Still unqualified: actual viewer-owned device/frame submission, stencil and MSAA, resize/device loss, more than 64 interleaved source runs, global ordering across two public licensed captures, real IFC plus point cloud, clipping/object-ID behavior, hardware resource budgets, and the full load/unload lifecycle. The borrowed-device result above does not establish these properties. The graph/paged renderer does not receive reverse-Z support from the depth patch.

# Native splat rendering contract: first counterexample

Tracking: [#8564](https://github.com/LTplus-AG/ifc-lite/issues/8564), part of [#8562](https://github.com/LTplus-AG/ifc-lite/issues/8562). Launch formats remain Gaussian PLY and `.splat`.

**Public enablement remains blocked.** This witness demonstrates that `SplatRenderer.drawMixed` cannot correctly compose transparent geometry between splats. It does not qualify the production viewer or complete the remaining rendering contract.

This directory contains an external luma browser-harness reproducer and static
research results. IFC-Lite does not import these files, and its root test command
does not execute the patch. They live under `docs/research` to distinguish that
evidence from runnable example code; the existing changed-tests oracle excludes
documentation. No oracle classification rule or acceptance requirement is changed.
The earlier [spike results](https://github.com/LTplus-AG/ifc-lite/blob/dd6a54799ec1853714076942b19db3b1bb82643e/examples/gaussian-splat-spike/results-summary.json) likewise record a
historical measurement, not a runtime configuration.

## Measured behavior

On upstream luma commit `700f1400fc6b0d32a82f1a22f57c1e747b255a01` with the depth-convention fix, render a near red Gaussian, a 50%-transparent green triangle at the intermediate depth, and a far blue Gaussian. The independent reference submits far splat, green triangle, near splat. The helper submits both sorted splats before the transparent triangle.

Center RGBA readback is `[189,33,24,255]` for the reference and `[94,128,24,255]` for `drawMixed`. The green triangle incorrectly covers the near red splat. The diagnostic test passes by asserting this counterexample; **exact composition fails**. Weighted transparency or sorting whole assets does not resolve this requirement.

Destroying the attached luma wrapper, then submitting a buffer clear through the original raw GPU device, succeeds without validation errors. This verifies borrowed-device survival for this isolated case.

The run used Chromium WebGPU with SwiftShader, not hardware performance qualification. The combined run passed 14 tests and skipped one existing configured-canvas reattachment test. The two depth readback tests and this diagnostic did not skip. Compact results and the original worker receipt ID are in `results.json`.

## Cleanup revision (PR #8570)

The original 14-pass/1-skip measurement above is retained unchanged. The revised
patch encloses attachment, rendering assertions and the borrowed-device probe
in an outer `finally`, conditionally destroys the witness buffer, and destroys
the raw device even if buffer cleanup throws. Wrapper teardown still precedes
the borrowed-device survival probe.

A fresh admitted Chromium/SwiftShader run on upstream depth-fix commit
`71e2be2394ecd9bdfb6f1d36ce23e6af92978015` passed **18 tests**, with the same one
configured-canvas skip. It reproduced both original pixel arrays and borrowed
device survival. Four added fault cases cover a pre-attach assertion, rejected
attachment, composition assertion, and ownership assertion after buffer creation.
Spies on real WebGPU methods verify exactly one raw-device destruction in every
case and exactly one witness-buffer destruction when allocated. These are failure
cleanup checks, not hardware or production-lifecycle qualification.

`results.json` separates the original measurement from this revised reproducer,
including both patch hashes and the new build/browser receipts. The pinned
Node 22.23.4 / Yarn 4.13.0 install and upstream build passed in an isolated source
export; the shared upstream checkout was left untouched. One earlier browser
submission never started because storage registration failed during build receipt
publication; its original receipt is retained separately from the successful run.

## Reproduce

Use upstream depth-fix commit `71e2be2394ecd9bdfb6f1d36ce23e6af92978015` from `louistrue/luma.gl` (base `700f1400fc6b0d32a82f1a22f57c1e747b255a01`). Apply `mixed-transparency.patch` there, install using its pinned Node/Yarn versions, build, then run its documented browser harness:

```sh
CI=1 corepack yarn test-headless --maxWorkers=2 --reporter=verbose \
  modules/engine/test/splats/ifc-mixed-transparency.spec.ts \
  modules/engine/test/splats/splat-depth-convention.spec.ts \
  modules/core/test/webgpu/adapter/webgpu-adapter-attach.spec.ts
```

This is the complete three-file selection recorded by successful receipt
`c7670da1-8e1a-4503-9cfd-6cc195dd0063` for the revised **18-pass/1-skip** run.
The first file alone runs only the five mixed-transparency diagnostics.

On the managed development fleet, execute through fleet admission and `ifc-gpu-check`. The patch is an external-harness diagnostic, not a test included by IFC-Lite's root test command.

## Remaining contract

A shared composition approach must preserve the rendered order of IFC glass/X-ray and Gaussian contributions; it needs adversarial intersection references before integration. Continue to reuse upstream Gaussian rendering. Do not enable a second standalone canvas as a production substitute.

Still unqualified: actual viewer-owned device/frame submission, stencil and MSAA, resize/device loss, more than 64 interleaved source runs, global ordering across two public licensed captures, real IFC plus point cloud, clipping/object-ID behavior, hardware resource budgets, and the full load/unload lifecycle. The borrowed-device result above does not establish these properties. The graph/paged renderer does not receive reverse-Z support from the depth patch.

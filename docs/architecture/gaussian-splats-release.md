# Gaussian PLY and .splat release gates

This is the implementation and rollout contract for [#8568](https://github.com/LTplus-AG/ifc-lite/issues/8568), under [#8562](https://github.com/LTplus-AG/ifc-lite/issues/8562). It is not a statement that the production viewer supports Gaussian captures. SPZ, SOG and CLI admission are outside this release.

## Current evidence and blockers

The research renderer in #8557 is isolated from the production viewer. The reverse-Z fix is proposed upstream in [luma.gl #3619](https://github.com/visgl/luma.gl/pull/3619). Its passing CI does not qualify native viewer integration.

The counterexample preserved in #8570 proves that upstream `drawMixed` composites an intermediate transparent mesh over a nearer splat. The reference center pixel is `[189,33,24,255]`; the helper produces `[94,128,24,255]`. Public enablement stays blocked until the chosen shared composition passes the adversarial reference contract in #8564. Borrowed-device survival passed in isolation. Hardware performance, all viewer workflows and rollback remain unqualified.

## Release state transitions

| State | Required evidence before entry | Admission behavior |
| --- | --- | --- |
| Disabled groundwork | Reviewed implementation and tests for the individual change | No public Gaussian admission; preserve ordinary point-cloud PLY and IFC behavior. |
| Internal qualification | #8564 rendering contract and #8565 loader/ownership acceptance | Explicit internal opt-in only; unsupported capabilities fail before allocating a renderer. |
| Opt-in cohort | #8566 workflows, #8567 corpus/resource verdict, and a demonstrated rollback | Eligible supported devices and scene limits only; no automatic default-on migration. |
| General availability | Cohort evidence reviewed, production smoke and rollback pass, published supported limits | Only the qualified format/device/scene combinations are enabled. |
| Admission disabled after regression | A reviewed disable change is deployed and smoke-tested | Reject new Gaussian loads before decoding; IFC and ordinary point clouds continue to load. |

The concrete flag and eligibility predicate belong to the canonical loader implementation. A UI-only hidden picker is insufficient: file drop, replacement, federation and project restoration all reach the same admission decision. Do not add a separate ingestion entry point or a second canvas for rollout.

Missing or failed evidence keeps the current state. A source-inspection verdict, synthetic scene, skipped fixture or SwiftShader run cannot be substituted for a required integrated/hardware measurement. Proposed budgets must be labeled proposed until the release owner approves them and #8567 measures them.

## Integration obligations

The implementation must preserve these existing ownership boundaries:

- `apps/viewer/src/hooks/useIfcLoader.ts`: primary and federated file admission, cancellation/session checks and error reporting.
- `apps/viewer/src/hooks/useIfcFederation.ts`: delegates loading to the canonical loader.
- `apps/viewer/src/store/slices/modelSlice.ts` and `modelSlice.teardown.ts`: remove/replace/clear lifecycle. New worker results must not resurrect a removed or superseded asset.
- `apps/viewer/src/store/slices/modelPlacementSlice.ts`: explicit placement; captures with unknown reconstruction scale must not acquire invented survey units.
- `apps/viewer/src/components/viewer/useWindowFileDrop.ts` and `toolbar/useFileCommands.tsx`: picker/drop discoverability must agree with actual loader eligibility.
- `apps/viewer/src/hooks/useBCF.ts` and its viewpoint helpers: camera, clipping and visibility semantics must remain explicit. Do not invent IFC entity IDs for splat assets or silently claim that existing BCF export embeds capture data.

These are integration points to verify, not assertions that the current modules already implement Gaussian assets. #8566 owns mounted UI and browser evidence once #8565 supplies a qualified asset contract.

### Implemented admission and lifecycle (#8565)

- **One decision.** `useIfcLoader.loadFile` detects a Gaussian capture by content (`inspectGaussianAdmission`) and hands it to `hooks/ingest/gaussianLoad.ts`. Picker, drop, Add model, `?model=` and any future restore reach the same `resolveGaussianQualification` call; there is no second entry point.
- **Disabled by default.** A public build refuses every capture before decoding: "Gaussian splat loading is disabled pending the native rendering contract." Internal qualification exists only in a build made for test/showcase use (`VITE_GAUSSIAN_SPLATS=internal-unqualified`, declared in the Turbo build environment) or for a caller that passes `gaussianQualification: 'internal-unqualified'` explicitly. Pickers list `.splat` only in such builds. The disable path is a build without the variable; already open tabs keep their bundle until reloaded.
- **Transaction.** Renderer readiness must be `blocked` without `upstream-capability-missing` before the worker decodes; loss, disposal and missing upstream capability refuse first. The decoded columns are normalized once (`normalizeGaussianAttributes`), the model's final index is reserved in the shared allocator, and `renderer.gaussianSplats.add(…, { qualification: 'internal-unqualified', signal })` uploads. The exact renderer-issued handle is published on the model (`FederatedModel.gaussianSplat`) or removed. A cancelled, superseded or rejected load leaves no worker, renderer asset or index reservation.
- **Ownership after publication.** `gaussianAssets.ts` reconciles with the store synchronously: removal, replacement, a primary reload and clear free the asset in the same tick; model visibility and isolate mirror onto it. Device loss is the renderer's: assets return to pending and re-upload, or report `reload-required`.
- **Placement.** Identity by default: raw source coordinates with no axis flip, unit, alignment or measurement claim (`calibration: 'uncalibrated'`). A caller-supplied matrix is recorded as `placementOrigin: 'explicit'`; showcase builds also accept the presenter's `?gaussianPlacement=rx180`. Nothing is inferred from a capture's contents.
- **Viewport scale.** When only captures are visible, the overlay reports that metric scale is unknown instead of showing metres. Mixed IFC/capture scenes retain the IFC scale with an uncalibrated-capture notice. Explicit placement does not establish calibration. Hidden captures do not add a notice.
- **Workflow limits.** Captures frame by their Gaussian centres, refuse whole-model rotation, are not GPU-pickable and get no IFC entity ids; selection is through the model list. Clipping culls whole Gaussians by centre (no caps; footprints can cross the plane). No measurement, snapping, export or project restore of capture contents is offered.

## Qualification journey

Run the journey in a fresh browser session for each supported device/antialiasing combination and pin the deployed commit and dependency versions in the receipt:

1. With Gaussian admission disabled, load IFC and ordinary point-cloud PLY. Attempt Gaussian PLY and `.splat` through picker, drop and federation; verify useful refusal, no decoder allocation and no change to already loaded models.
2. Enable the internal cohort. Load IFC first then each supported capture format; repeat splat-first and with two overlapping captures. Verify progress, cancellation, meaningful failure messages and bounded resource use.
3. Inspect in perspective and orthographic views. Exercise glass/X-ray intersections, clipping planes and boxes, screenshots, resize and the supported MSAA modes against reference evidence.
4. Toggle visibility/isolate, fit each asset and select an asset alongside an IFC entity. Verify that IFC selection and snapping retain their existing identity and measurement semantics.
5. Save and reopen through each supported project/viewpoint route. Restore placement and visibility where promised; report unavailable local sources explicitly. Unsupported export must be explicit and must not silently omit a promised capture.
6. Remove, replace and cancel repeatedly, including rapid superseding loads, suspension and device loss. Record worker termination and retained CPU/GPU resource outcomes; absence of an exception is not a memory verdict.
7. Disable new admission through the tested rollback path. Verify new Gaussian loads are refused while IFC and ordinary PLY still work. Resolve already-loaded assets by the documented lifecycle policy; do not destroy an app-owned GPU device to perform rollback.

Screenshots establish visible behavior; they do not replace transparent-composition readbacks, cancellation assertions or retained-resource measurements. #8567 owns the real licensed corpus and performance budgets. No model contents, file paths, raw file names or reconstruction coordinates may be added to rollout telemetry.

### Public metric corpus (#8567)

The [University of Edinburgh Synthetic building dataset](https://doi.org/10.7488/ds/2893) supplies one `model.ifc` and one `cloud_coloured.e57` under CC BY 4.0. Attribute it to Enrique Valero (2021), Cyberbuild Lab, The University of Edinburgh, and mark the LAZ and PLY as derivatives. The IFC declares millimetres; the E57 is metre scale, Z-up, with an identity scan pose. The committed [derivation recipe](https://github.com/LTplus-AG/ifc-lite/blob/main/examples/gaussian-splat-spike/derive-edinburgh-triple.py) makes a 12 mm voxel-averaged LAZ and a 48 mm voxel-averaged SH3 Gaussian PLY. The PLY has 413,176 isotropic scan-point splats (102,469,179 bytes); its 45 higher-order SH coefficients are zero because the dataset has no camera views for view-dependent training. It is a metric, co-registered scan rendering proxy, not a trained photographic capture.

Offline identity-frame measurement on 50,000 deterministic scan points gave a **5.17 mm** scan-to-IFC wall/slab median in the <15 cm band (100% of the sample), **18.40 mm** scan-to-nearest-splat-centre median, and **0.860** IFC/scan AABB IoU. IfcOpenShell tessellation used an in-memory `IFC4X1` → `IFC4` schema-header substitution because the installed build lacks IFC4X1; the published IFC was not changed. The exact source and derivative sizes, SHA-256 pins, licence evidence and full-precision measurements are in [the corpus manifest](https://github.com/LTplus-AG/ifc-lite/blob/main/tests/models/manifest.json) and [the measurement receipt](https://github.com/LTplus-AG/ifc-lite/blob/main/examples/gaussian-splat-spike/edinburgh-measurement.json).

The separate 32-batch analytic SH3 witness is generated by `qualificationPly({ batches: 32, perBatch: 257 })` and pinned in the same manifest. It exercises batch depth order; it has no survey provenance. The Edinburgh source is artificially generated and cannot substitute for a real-world scan or hardware/rendering qualification.

## Deployment and rollback

Use `.github/workflows/deploy-nightly.yml`, not a direct push or force-update of `production`. It normally advances production at 05:45 UTC. Manual dispatch requires the requested commit to be reachable from `main` and on its first-parent line within the 40-commit window starting at the current main tip. A merged PR branch head is not sufficient. Retain the default green-check requirement: within that same window, the workflow selects the newest commit at or older than the requested commit whose latest `Build + WASM + Rust + Node` check succeeded. It can therefore select an older commit, or fail if no eligible green commit exists. PR builds and merge completion do not themselves prove production availability.

Before promoting an opt-in or default-on change:

- Record the candidate main SHA, the previous production SHA and the exact enable/disable mechanism implemented by #8565/#8566.
- Attach #8564–#8567 verdicts and the proposed supported formats/devices/limits; reject placeholders or missing mandatory fixtures.
- Prepare the reviewed disable change and rehearse it on the same deployment path. Record the observed existing-asset policy, not an assumed hot-toggle capability.
- Dispatch or await normal promotion, then verify the deployed commit and perform the applicable qualification journey on the live viewer.

The production branch only moves forward. Rollback therefore means a new reviewed main commit that disables Gaussian admission and is promoted normally; it does not mean rewinding production or deploying an unreviewed branch. Verify the actual production SHA reported by the workflow, not just the requested SHA: green-ancestor selection can predate the disable change, and an already-ahead production branch can remain unchanged. Confirm that the actual deployed SHA contains the admission-disable change and that each production deployment is `READY`, then smoke-test refusal of new Gaussian loads. A green workflow run without Vercel verification (for example, a missing `VERCEL_TOKEN`) is not deployment evidence. A previously open tab may still run an older bundle. The implementation and smoke test must describe reload/notification behavior explicitly rather than claiming immediate shutdown of existing tabs.

Capture a compact receipt containing commit, deployment URL, browser/GPU identity, corpus hashes, flag/cohort state, actual checks/skips, outcomes and the rollback commit/deployment. Preserve private evidence separately. A production smoke failure keeps general availability blocked and triggers the prepared admission-disable path.

## Ownership and completion

The authenticated assignee of #8562 owns the release decision and coordinates the milestone assignees. Dependency upgrades must rerun the same regression corpus before changing supported limits. Assign ongoing upgrade ownership in the release receipt; a package version bump alone does not renew qualification.

This document completes rollout preparation only. #8568 remains open until qualified production availability, deployed smoke tests and rollback evidence exist. #8566 remains open until the actual gated viewer journey is implemented and passes. No unchecked milestone is closed by landing this document.

# Gaussian PLY and .splat release

This is the implementation and rollout contract for [#8568](https://github.com/LTplus-AG/ifc-lite/issues/8568), under [#8562](https://github.com/LTplus-AG/ifc-lite/issues/8562). SPZ, SOG and CLI admission are outside this release.

## Release decision: direct general availability

On 2026-11-03 the release owner decided (comments on #8562 and #8568) to ship Gaussian PLY and `.splat` captures in the production viewer as a regular feature: admitted by default, with no experimental flag and no opt-in cohort. The feature does not have to be perfect; its known limits ship disclosed, in the capture panel and in the user guide ([`docs/guide/gaussian-captures.md`](../guide/gaussian-captures.md)). The release therefore moves straight from disabled groundwork to general availability, skipping the internal-qualification and cohort states below. Rollback is unchanged: a reviewed commit that disables admission.

## Evidence and known limits

The research renderer in #8557 is isolated from the production viewer. The reverse-Z fix is proposed upstream in [luma.gl #3619](https://github.com/visgl/luma.gl/pull/3619).

The counterexample preserved in #8570 proves that upstream `drawMixed` composites an intermediate transparent mesh over a nearer splat (reference center pixel `[189,33,24,255]`, helper `[94,128,24,255]`). Since #8743 the shipped renderer composes captures with transparent IFC by a nearest-glass split: exact behind one transparent layer, approximate between two or more layers and in X-ray, which is the disclosed composition limitation (#8564 verdict, [research README](https://github.com/LTplus-AG/ifc-lite/blob/main/docs/research/gaussian-splat-contract/README.md#verdict-for-8564-2026-11-04)). Borrowed-device survival passed in isolation. Hardware performance budgets (#8567) were not measured before launch; the published limits below bound resource use instead.

## Release state transitions

| State | Required evidence before entry | Admission behavior |
| --- | --- | --- |
| Disabled groundwork | Reviewed implementation and tests for the individual change | No public Gaussian admission; preserve ordinary point-cloud PLY and IFC behavior. |
| Internal qualification | Skipped by the 2026-11-03 decision | — |
| Opt-in cohort | Skipped by the 2026-11-03 decision | — |
| General availability (current) | Release-owner decision, published limits and disclosed limitations, a tested kill switch | Admitted by default within the published limits. |
| Admission disabled after regression | A reviewed disable change is deployed and smoke-tested | Reject new Gaussian loads before decoding; IFC and ordinary point clouds continue to load. |

The flag and eligibility predicate belong to the canonical loader implementation. A UI-only hidden picker is insufficient: file drop, replacement, federation and project restoration all reach the same admission decision. Do not add a separate ingestion entry point or a second canvas.

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

- **One decision.** `useIfcLoader.loadFile` detects a Gaussian capture by content (`inspectGaussianAdmission`) and hands it to `hooks/ingest/gaussianLoad.ts`. Picker, drop, Add model, `?model=`, federation restore and capture reload all reach the same `gaussianAdmissionEnabled()` call (`hooks/ingest/gaussianAdmissionPolicy.ts`); there is no second entry point. Pickers and drop list `.splat` from the same predicate.
- **On by default; one kill switch.** The default lives in one place, `GAUSSIAN_SPLATS_DEFAULT` (`'enabled'`). A build with `VITE_GAUSSIAN_SPLATS=disabled` (declared in the Turbo build environment) refuses every capture before decoding with "Gaussian capture loading is turned off in this viewer build. IFC models and point clouds still load.", and pickers stop offering `.splat`. Any other non-empty value except `enabled` and the presenter build's `internal-unqualified` also disables (a mistyped kill switch fails closed). `internal-unqualified` additionally honours the presenter's `?gaussianPlacement=rx180`. The renderer adapter's `{ qualification: 'internal-unqualified' }` acknowledgement remains an internal call detail of the upload; it is not the admission decision and `packages/renderer` types are unchanged.
- **Launch limits.** Defined once in `GAUSSIAN_LAUNCH_LIMITS` (`hooks/ingest/gaussianLaunchLimits.ts`) and published in the user guide: a capture of at most 500 MB, at most 1,000,000 splats per scene (all captures, including loads still decoding), spherical-harmonics degree at most 3, and a WebGPU device (the viewer's renderer). Size, per-capture count and degree are read from the file size and header by admission; the scene budget (`gaussianSceneBudget.ts`) counts captures whose renderer asset is live plus in-flight reservations. Every limit refuses before the decoder worker starts or any renderer allocation, with a translated message naming the limit.
- **Disclosed limitations.** The capture panel's limitations section and the user guide list them: approximate composition with glass/X-ray, clipping by Gaussian centre, uncalibrated captures, not pickable (select from the model list), no measurement or snapping, not included in exports. Export dialogs never offer a capture as a source, merged IFC export skips captures, and every `ExportDialogShell` dialog shows a notice while captures are loaded (`lib/export/capture-export.ts`).
- **Diagnostics without content.** Each settled load emits `gaussian_capture_load` with `outcome` (`completed`/`failed`/`cancelled`/`refused`), a fixed `code` for failures and refusals, `format`, `size_bucket` and `splat_bucket`. A device loss or recovery while a capture is loaded emits `gaussian_capture_device` with `phase`, `loss_count` and `recovery_count`. The schema and its `before_send` allowlist are `lib/analytics-capture-events.ts`; file names, paths, URLs, coordinates and contents are never sent.
- **Transaction.** Renderer readiness must be `blocked` without `upstream-capability-missing` before the worker decodes; loss, disposal and missing upstream capability refuse first. The decoded columns are normalized once (`normalizeGaussianAttributes`), the model's final index is reserved in the shared allocator, and `renderer.gaussianSplats.add(…, { qualification: 'internal-unqualified', signal })` uploads. The exact renderer-issued handle is published on the model (`FederatedModel.gaussianSplat`) or removed. A cancelled, superseded or rejected load leaves no worker, renderer asset or index reservation.
- **Ownership after publication.** `gaussianAssets.ts` reconciles with the store synchronously: removal, replacement, a primary reload and clear free the asset in the same tick; model visibility and isolate mirror onto it. Device loss is the renderer's: assets return to pending and re-upload, or report `reload-required`.
- **Placement.** Default source axes follow point-cloud ingest (`pointCloudFrame.ts`): Z-up to Y-up, with a per-capture Y-up override. `gaussianCaptureFrame.ts` composes `T(−totalYupOffset(sharedRenderFrame(...))) · placement · axes` on ingest; `sharedRenderFrame` excludes captures. Ingest rebases CPU positions around their source centre and restores that centre in the upload matrix in f64, keeping survey coordinates within the renderer anchor envelope. The renderer transforms centres, covariance and spherical harmonics together. This establishes no units, survey alignment or measurement claim (`calibration: 'uncalibrated'`). `gaussianUpAxis` and the unbaked `sourcePlacement` survive reload and portable setup restore; the baked render offset is not serialized. A caller-supplied matrix is recorded as `placementOrigin: 'explicit'`; showcase builds also accept the presenter's `?gaussianPlacement=rx180`. Nothing is inferred from a capture's contents.
- **Viewport scale.** When only captures are visible, the overlay reports that metric scale is unknown instead of showing metres. Mixed IFC/capture scenes retain the IFC scale with an uncalibrated-capture notice. Explicit placement does not establish calibration. Hidden captures do not add a notice.
- **Workflow limits.** Captures frame by their Gaussian centres, refuse whole-model rotation, are not GPU-pickable and get no IFC entity ids; selection is through the model list. Clipping culls whole Gaussians by centre (no caps; footprints can cross the plane). No measurement, snapping, export or restore of capture contents is offered; a federation setup restores a capture by re-reading its source file.

## Resilience outcomes (#8567)

The mounted loader tests use real admission, decoding, store reconciliation,
model-index allocation and the Gaussian renderer layer. The worker transport and
GPU upload use the recording seams in `apps/viewer/src/test/gaussian-loader-harness.ts`.

| Case | Expected outcome | Test file: test name |
| --- | --- | --- |
| Malformed PLY and .splat | Truncated payloads, wrong header/count, list properties and empty or partial .splat records refuse as `gaussian_invalid_input`; non-finite decoded values fail as `gaussian_load_failed`. No capture asset or model remains. | `apps/viewer/src/hooks/useIfcLoader.gaussianLaunch.test.tsx`: `malformed Gaussian captures leave no renderer asset or model and report a fixed refusal code (#8567)`; `apps/viewer/src/hooks/ingest/gaussianDecode.test.ts`: `rejects upstream-preserved … before publication (#8565)` |
| Resource exhaustion | Files above 500 MB, scenes above 1,000,000 splats and SH above degree 3 refuse before decoding with the published limit message. Removal returns the scene budget to zero. | `apps/viewer/src/hooks/useIfcLoader.gaussianLaunch.test.tsx`: `a capture over 500 MB`, `a capture with more splats than a scene can hold`, `a capture with spherical harmonics above degree 3`, `a load that would take the scene past 1,000,000 splats, counting loads still decoding`; `apps/viewer/src/hooks/useIfcLoader.gaussian.test.tsx`: `fifty load and remove cycles release every Gaussian owner, index and scene share (#8567)` |
| Repeated load/remove | Fifty cycles leave no model, registry owner, renderer asset, live handle, held model-index slot or scene-budget share. | `apps/viewer/src/hooks/useIfcLoader.gaussian.test.tsx`: `fifty load and remove cycles release every Gaussian owner, index and scene share (#8567)` |
| Rapid replacement | Several overlapping primary loads leave exactly one resident asset and model; the last requested capture wins and all decoder workers terminate. | `apps/viewer/src/hooks/useIfcLoader.gaussian.test.tsx`: `overlapping primary replacements leave only the final capture and its handle (#8567)` |
| Tab suspension | Hidden/visible `visibilitychange` during decoding and after publication leaves a valid resident capture when the tab resumes. | `apps/viewer/src/hooks/useIfcLoader.gaussian.test.tsx`: `visibility changes during decoding and after publication preserve the capture (#8567)` |
| Device loss | A recoverable loss makes assets pending and re-uploads them; a cleared recovery reports `reload-required`. Reloading from the retained source restores placement and up axis. | `packages/renderer/src/gaussian-splat-layer.test.ts`: `#8564 loss drops residency at once; recovery re-uploads under the same handle`, `#8564 failed re-upload or a cleared scene marks assets reload-required`; `apps/viewer/src/hooks/useIfcLoader.gaussian.test.tsx`: `device recovery requiring reload restores the source placement and up axis (#8567)` |

## Qualification journey

Run the journey in a fresh browser session for each supported device/antialiasing combination and pin the deployed commit and dependency versions in the receipt:

1. In a kill-switch build (`VITE_GAUSSIAN_SPLATS=disabled`), load IFC and ordinary point-cloud PLY. Verify picker/drop omit `.splat`. Use the `?model=` URL route for Gaussian PLY and `.splat` to assert the kill-switch refusal message; also verify federation admission refuses captures, no decoder is allocated and already loaded models stay unchanged.
2. In the default build, load IFC first then each supported capture format; repeat splat-first and with two overlapping captures. Verify progress, cancellation, meaningful failure messages, each launch limit's refusal and bounded resource use.
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

Before promoting the default-on change:

- Record the candidate main SHA, the previous production SHA and the enable/disable mechanism: `GAUSSIAN_SPLATS_DEFAULT` and the `VITE_GAUSSIAN_SPLATS=disabled` build override.
- Record the published limits (`GAUSSIAN_LAUNCH_LIMITS`) and the disclosed limitations; attach whatever #8564–#8567 evidence exists, labelled as such.
- Prepare the reviewed disable change (`GAUSSIAN_SPLATS_DEFAULT = 'disabled'`) and rehearse it on the same deployment path. Record the observed existing-asset policy, not an assumed hot-toggle capability.
- Dispatch or await normal promotion, then verify the deployed commit and perform the applicable qualification journey on the live viewer.

The production branch only moves forward. Rollback therefore means a new reviewed main commit that disables Gaussian admission (set `GAUSSIAN_SPLATS_DEFAULT` to `'disabled'`, or set `VITE_GAUSSIAN_SPLATS=disabled` in the production build environment) and is promoted normally; it does not mean rewinding production or deploying an unreviewed branch. Verify the actual production SHA reported by the workflow, not just the requested SHA: green-ancestor selection can predate the disable change, and an already-ahead production branch can remain unchanged. Confirm that the actual deployed SHA contains the admission-disable change and that each production deployment is `READY`, then smoke-test refusal of new Gaussian loads. A green workflow run without Vercel verification (for example, a missing `VERCEL_TOKEN`) is not deployment evidence. A previously open tab may still run an older bundle. The implementation and smoke test must describe reload/notification behavior explicitly rather than claiming immediate shutdown of existing tabs.

Capture a compact receipt containing commit, deployment URL, browser/GPU identity, corpus hashes, admission mode, actual checks/skips, outcomes and the rollback commit/deployment. Preserve private evidence separately. A production smoke failure triggers the prepared admission-disable path.

### Production admission-disable runbook (#8745)

1. Create a reviewed change setting `GAUSSIAN_SPLATS_DEFAULT = 'disabled'` in
   `apps/viewer/src/hooks/ingest/gaussianAdmissionPolicy.ts`. Merge the disable
   commit through the normal queue and record its **main first-parent SHA**.
   This runbook uses the reviewed code change: `deploy-nightly.yml` does not
   rebuild an unchanged production commit. Setting a build environment variable
   alone cannot change an existing bundle and is not this deployment procedure.
2. After its required checks pass, dispatch a **recent first-parent `main` SHA
   containing the disable change**: `deploy-nightly.yml` accepts only the
   40-commit first-parent window starting at the current main tip. If the disable
   commit has aged outside that window, choose a recent descendant in the window
   that contains it. Set `DISABLE_MAIN_SHA` below to that SHA, and retain
   `require_green` (then verify the actual deployed SHA as described below):
   ```sh
   gh workflow run deploy-nightly.yml -R LTplus-AG/ifc-lite --ref main -f ref=DISABLE_MAIN_SHA -f require_green=true
   gh run list -R LTplus-AG/ifc-lite --workflow deploy-nightly.yml --limit 5
   gh run watch RUN_ID -R LTplus-AG/ifc-lite --exit-status
   gh run view RUN_ID -R LTplus-AG/ifc-lite --log
   gh api repos/LTplus-AG/ifc-lite/git/ref/heads/production --jq .object.sha
   ```
   Use the actual `sha` emitted by the advance step, and verify it contains the
   disable commit. Green-ancestor selection may choose an older commit; an
   already-ahead production branch may stay unchanged. Either case requires
   investigation if the resulting SHA lacks the disable. Never force production.
3. Verify the workflow's Vercel verification step reports a production deployment
   **READY for that exact SHA for all three projects**. A skipped verification
   step or a green advance step alone is insufficient. Inspect the deployment's
   Git SHA and production URL in Vercel as well; do not test a preview URL.
4. Open a fresh Chromium tab at the production viewer URL. Load the catalogued
   `gaussian/plant.splat` through the existing `?model=` route (serve the fixture
   at a same-origin URL). Disabled pickers/drop stop offering `.splat` before
   the loader, so use URL loading to verify its kill-switch message. Expect “Gaussian capture
   loading is turned off in this viewer build. IFC models and point clouds still
   load.” Observe browser workers from before navigation: no
   `gaussianDecode.worker` may start for the refused load and no capture may be
   added to the model list. Then open `AC20-FZK-Haus.ifc` and an ordinary XYZ/RGB
   `.ply`; both must publish models and render. Record SHA, URL, browser/GPU,
   fixture hashes, worker URLs and outcomes. Repeat the capture in the default
   bundle when rehearsing locally; it must load using the decode worker.
5. Already-open tabs keep their old JavaScript and any resident captures. There
   is no remote flag polling, forced tab reload or retroactive asset destruction.
   Ask users to reload the viewer after saving their work; verify refusal in a
   fresh/reloaded tab. Removing a capture still follows normal asset teardown.

The PR's “Rollback rehearsal” records local production-build evidence only. It
neither dispatches this workflow nor claims a production deployment occurred.

## Ownership and completion

The authenticated assignee of #8562 owns the release decision and coordinates the milestone assignees. Dependency upgrades must rerun the same regression corpus before changing supported limits. Assign ongoing upgrade ownership in the release receipt; a package version bump alone does not renew qualification.

Landing the default-on change does not close #8568: it remains open until production availability, a deployed smoke test and rollback evidence exist. #8566 remains open until the browser journey runs in CI and passes. No unchecked milestone is closed by landing this document.

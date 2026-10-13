# Reduced reporter fixture functional probe (#6729)

The `Reporter 6729 hosted functional probe` workflow imports the
reporter's authentic 22,701-byte IFC4 attachment through the real viewer file
input and canonical loader. Its SHA256 is
`cc6fbbf632c2779891e485c3297d437b1d8555448934b8c8b5a3cce5326553a2`.
The source is the reporter's [issue attachment](https://github.com/LTplus-AG/ifc-lite/issues/6729#issuecomment-6145427701).
The attachment is fetched at execution and verified before parsing; model
bytes are neither committed nor added to the fixture catalogue.
It runs for PR changes to its five own files and through manual dispatch after
default-branch registration. PR evidence names the actual synthetic merge
commit; manual evidence names the dispatched workflow commit. Neither is
silently attributed to the PR head or a different main revision.

This is a first-stage evidence recorder, **not an occlusion acceptance verdict**.
No execution result is committed here. It records actual displayed element
count separately from store entity count and mesh count; none is guessed from
STEP records. It captures front, side and oblique views at two zoom levels,
in perspective and orthographic projection, unselected and with each nut
selected: 36 renderer PNGs, corresponding UI screenshots and actual camera,
projection, scene bounds, relative-to-eye frame, canvas and identity metadata.
Matched projections preserve eye/target/up and center-plane scale. Selection
uses canonical store-backed entity resolution without removing occluders.

The workflow runs exclusively on a GitHub-hosted Ubuntu runner using real
Chrome and software WebGPU/SwiftShader. GPU and page failures are retained;
no GPU assertion is waived and a missing/skipped witness cannot qualify. A
production color readback records actual renderer pixels. Non-background
variation alone can also reflect grid/overlays; image review must establish
assembly visibility. UI compositor screenshots alone can be blank on software
WebGPU. Frame presence does not
prove correct geometry, clipping, picking, surface occlusion or outlines.
Actual source/tree, browser/GPU diagnostics and built WASM hashes accompany
the observations. The probe uses an isolated source server of that checkout,
never a preview borrowed from another process. The built viewer dependency
graph supplies the real package/WASM runtime.
The hosted workflow runs literal root `pnpm typecheck` after building, then
checks the three probe TypeScript files and viewer ambient declarations using
an ephemeral config extending the viewer config. Viewer aliases are retained;
the supplemental check emits no JavaScript or declarations. Its configuration
is retained with the provenance. Neither check has been run locally.

The instrumentation records browser and Node clock origins, timed console
observations, renderer readiness/loss flags, probe-local object identity IDs,
actual render epochs, resident-byte/frame diagnostics, and Chrome process
snapshots before/after import and capture attempts. The source server's DEV
mode and React StrictMode are explicit confounds. Documented Playwright
`DEBUG=pw:browser` retains browser-process logs for this fresh unsigned context
and already-public fixture. No authenticated state or keys are supplied.
These observations never clear prior errors: any loss or diagnostic failure
still fails qualification, including when recovery later reports success.

Review captured coordinates and assembly placement before implementing the
independent pinned IfcOpenShell triangle/clearance witness. That second stage
is deliberately absent. The existing synthetic depth tests remain separate
controls. The reduced file does not contain the original video's target GUID
and does not establish identity with the full 23.74 MB `OUT.IFC`.

These observations provide no physical-display GPU or performance acceptance
for #6709/#6975 and do not automatically close #6729. No deployment, user
report admission or model-upload system is activated by this workflow.

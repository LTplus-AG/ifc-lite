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
Target framing uses the union of both nuts' real renderer world-space mesh
bounds, looked up through their source-verified canonical global IDs. The
full scene and all occluders retain their visibility settings; no isolation, hidden
mesh, geometry substitution or clipping-plane change is requested. A bounding
sphere fit using the narrower horizontal/vertical camera cone and a fixed 10%
margin keeps the target pair in frame at zoom2; zoom1 uses twice that distance.
The bounds, source identities and fitting parameters are retained separately
from the unchanged full scene bounds. This changes the diagnostic camera focus
from the long surrounding members to the reported fasteners; it does not prove
hole geometry or occlusion and never lowers the strict density/error criteria.
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
The next diagnostic environment supplies an Xvfb display to the same headless
Chrome configuration. The recorded failed cohort reported early ANGLE display
initialization failures and later shared-image creation errors. Providing a
display is a bounded investigation of that hosted environment, not a renderer
fix or an established explanation of the production report. The workflow
requires `xvfb-run`, `Xvfb` and `xauth` from Playwright's existing browser
dependency installation, and records their package versions and actual
`DISPLAY`. Chrome/backend flags, source server mode, timeouts, instrumentation,
all 36 required frames and failure criteria remain unchanged. Any loss or
error still fails the cohort; no prior failed result is replaced by this run.

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
Density failures are retained per raw readback and PNG while later camera and
selection views are collected. The existing classifiers and threshold remain
unchanged: every density failure still causes the final cohort to fail with
`INCOMPLETE` status, even when all 36 diagnostic images exist. Missing raw or
PNG readbacks, identity/matrix failures and page/device/diagnostic errors still
stop collection. This records more evidence; it grants no acceptance waiver.
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

## Paired projection depth isolation

`tests/e2e/projection-depth.e2e.spec.ts` supplies a separate synthetic invariant
for the residual ordering defect. Run it without a shared preview or IFC/WASM
runtime:

```sh
pnpm test:projection-depth
```

The dedicated config requests software WebGPU on full Chrome. An existing full
Chromium binary can be selected with `DEPTH_WITNESS_CHROME=/absolute/path/to/chrome`.
The root command builds the small `load-trace` dependency through Turbo first;
it does not require a full viewer build or a WASM runtime. This preparation is
required in a fresh fleet checkout as well as on a developer machine.
An unavailable adapter or lost device is a failure, never a skip or acceptance.
The spec is also included in both regular viewer E2E project matchers.
Root `pnpm typecheck` checks the witness's browser, fixture, spec and config
through `projection-depth.tsconfig.json` in the existing typecheck tail.
`DEPTH_WITNESS_GPU=native` requests the normal native ANGLE path instead;
only the returned adapter identity establishes whether physical hardware ran.

The same two opaque squares and eye/target/up are rendered in perspective and
orthographic projection with matched center-plane scale. The foreground square
must hide the background square across five orbit angles, both draw orders,
1/4/30mm separations, three scene depth ranges, MSAA 1/4, and the actual flat,
quantized and instanced colour vertex stages. A diagnostic fragment reports
front/rear sample ownership as red/green, excluding lighting and selection.
An independent f64 ray/plane oracle establishes front-first visibility and
silhouette clearance over the entire central probe, including all possible
hardware sample positions. It never uses the depth-nudge formula as an oracle.

The control shader replaces only the composed nudge helper with identity.
It does not modify production files or geometry. The report retains shader
digests, actual packed IDs/lanes, matrices, geometric clearance, pixel counts,
adapter/browser identity, source revision, dirty-tree status and source hashes.
All 1,440 distinct visibility cases must pass, including the orthographic 1mm and 4mm
invariants that the former depth-ranking mechanism violated. The 1,080 orthographic
rows sweep scene range; the 360 perspective controls use the real infinite-far
projection and record `range: null`. Earlier 2,160-row reports repeated those
perspective controls three times; they do not establish additional range coverage. Production cases
execute the actual geometric prepass and guarded colour pass; identity-nudge
controls retain their independent single-pass path. The same command also runs
240 real selection/hover mask cases, including maximal-rank hidden sources
behind rank-zero 1mm occluders. Intentional hidden selection silhouettes remain
present. Reports require zero GPU validation errors.

With a built viewer dependency graph and real WASM runtime, run existing
coplanar ownership, annotation, override and clipping controls plus the reduced
reporter recorder using `DEPTH_WITNESS_VIEWER=1 pnpm test:projection-depth`.
Set `REPORTER_6729_IFC` to the pinned public attachment and `E2E_GPU_STRICT=1`
for the reporter cohort; its absence skips that cohort rather than granting
acceptance. This uses the same isolated browser and private source servers.

This isolates the renderer's ordering mechanism. It is not an authentic
nut/bolt or plate topology check, selection acceptance, continuous viewer-motion
test, native-GPU verdict or claim that the reporter's exact model is repaired.

The implementation, final coverage and explicit acceptance limits are recorded
in [orthographic-fix.md](./orthographic-fix.md). The synthetic command also
executes the real textured fragment with cutout and partial-index witnesses.

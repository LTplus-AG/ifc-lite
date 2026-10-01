# 2D section zoom and reference improvements

Status: implemented, with recorded browser/export evidence and explicit remaining acceptance gaps. The findings below preserve the original hosted-baseline analysis; the implementation status and current validation appear at the end.

Issues: [#6614 — Zooming](https://github.com/LTplus-AG/ifc-lite/issues/6614) and [#6615 — Improvements](https://github.com/LTplus-AG/ifc-lite/issues/6615). Both carried `ready` when read on 2026-10-01. Neither had comments or an attached reproduction model. #6615 contains three distinct requests; its acceptance must cover each explicitly.

## Findings and scope

| Request | Hosted-baseline behavior | Work required at baseline |
| --- | --- | --- |
| Less sensitive 2D zoom; Ctrl+scroll like 3D | Every wheel event changes scale by a fixed 10%; magnitude and modifiers are ignored | Delta-based zoom, fine modifier, gesture routing and zero-delta handling |
| Nearby background geometry in section | Cardinal projection exists, including hidden-line classification; vertical depth is half the model extent | User-controlled depth and independent visual verification of wall/window projection |
| DXF in a side section | Import succeeds; drawing render hook returns no DXF data outside plan views; centering is disabled | Explicit section reference placement and rendering |
| PDF underlays | Drawing Underlays accepts only DXF; Appearance already imports, calibrates and renders PDF rasters in side sections | Connect section Underlays to existing references, clarify workflow and export scope |

Do not describe PDF support as wholly missing. Browser testing placed a calibrated PDF on a vertical YZ plane, and toggling its visibility changed 17,121 pixels in the real side-section canvas. The issue is discoverability and workflow integration, plus deliverable behavior, rather than a missing decoder.

## Evidence and limits

Source baseline: `ab97764f42222177ac3c64b98f6aa2262c15a98a`. Browser: hosted [v3.4.0 viewer](https://www.ifclite.com/), deployment asset prefix `dpl_D9Z1NTZP4fQCNJFYAhtDiUy7A8R2`, on 2026-10-01. The checkout had no installed dependencies or built workspace packages; the browser run did not validate a local build. Version equality does not establish commit equality.

Model: the viewer's `samples/building-architecture.ifc`, loaded through **Load demo project**. It reports IFC4, 444 entities and 12 elements with geometry; drawing generation processed 1,106 triangles. DXF: a deliberately synthetic one-line, metre-unit file to test import eligibility, not a CAD fidelity oracle. PDF: the existing `evidence/pdf-fidelity-report/control-text-accepted.pdf` (774 bytes, two pages), including a rotated page, offset page box and UserUnit 2.

The T3 browser could navigate, click and evaluate. Full-page snapshots repeatedly failed, including explicit-tab and saved-image requests. DOM inspection and real canvas captures supply the evidence; there is no full-page screenshot. Synthetic wheel events exercise the actual event listener but cannot establish physical trackpad feel or browser page-zoom suppression. File inputs were supplied using File/DataTransfer change events, then real UI handlers performed parsing and registration. Reference visibility was toggled through the existing store action for the pixel comparison.

Raw observations: [browser-observations.json](evidence/section-6614-6615/browser-observations.json). Canvas captures: [PDF visible](evidence/section-6614-6615/pdf-side-visible.png), [PDF hidden](evidence/section-6614-6615/pdf-side-hidden.png).

| Wheel input, each starting after Fit | Before | After | Conclusion |
| --- | --- | --- | --- |
| deltaY = +1 pixel | 1222% | 1100% | Tiny event gives full step |
| deltaY = +100 pixels | 1222% | 1100% | Magnitude ignored |
| deltaY = 0 | 1222% | 1344% | Zero input incorrectly zooms in |
| deltaX = 100, deltaY = 0 | 1222% | 1344% | Horizontal scroll incorrectly zooms in |
| Physical-key-event Ctrl + deltaY = 100 | 1222% | 1100% | No fine modifier |
| deltaY = 3, line mode | 1222% | 1100% | Units ignored |
| Twenty deltaY = +1 events | 1222% | 149% | Event count compounds sensitivity |

Displayed percentages are rounded and represent canvas scale, not a paper scale denominator. All dispatched events were default-prevented. The exact mathematical multiplier for twenty positive events is `0.9^20 ≈ 0.1216`.

Projection OFF on Down produced 24 cut lines, 5 polygons, no projection lines. ON produced 294 projection lines and 27 hidden lines. Side at 50% produced 18 projection lines, no cut polygons, with `projectionBelowDepth = 19.271267354488373 m` and `projectionAboveDepth = 0.001 m`. The model has a wide site extent; 50% is not a guaranteed building cut. These numbers establish projection execution and automatic depth, not that the reporter's missing wall/window silhouette is correct.

After importing DXF on Side, the inspector listed 1 layer / 1 path, displayed “Underlays render on plan (top-down) sections”, and disabled “Center on model (switch to a plan view first)”. PDF remained absent from the DXF picker while the Appearance picker accepted it.

## #6614: navigation contract

### Product behavior

Keep plain-wheel zoom available in Default and Navisworks navigation presets. A physically held Ctrl or Cmd enables fine zoom; it is not a requirement for all zoom. This follows the existing 3D fine-zoom convention and preserves the issue's “similar to 3D” intent. In Trackpad preset, ordinary two-axis scroll pans and pinch/Ctrl+wheel zooms. Show the applicable hint in the drawing footer and help; keyboard +/- and Fit remain available.

Fine zoom uses the existing `FINE_ZOOM_STEP_FACTOR = 0.2` and `createFineZoomModifierTracker` / `isFineZoomWheel`. A pinch carrying `ctrlKey` without a physical modifier press keeps normal zoom sensitivity. Release and blur reset the modifier. Accept Cmd alongside Ctrl as the current 3D tracker does.

Normalize wheel deltaMode to CSS pixels: pixel units unchanged, line units use 16 px per line, page units use the drawing container height. Proposed normal zoom multiplier: `exp(-k * normalizedDeltaY)`, with `k = log(1.1) / 100`; apply the fine factor to the exponent. A +100 px input yields approximately 0.9091x, -100 px approximately 1.1x; fine steps are approximately 0.9811x / 1.0192x. These are initial tuning values, subject to physical-device acceptance, not performance measurements.

Clamp each event's logarithmic scale change to ±log(1.25) to bound extreme wheel values. Retain the existing 0.01 minimum scale; reject non-finite input and any overflow. Zoom-in then equal zoom-out returns to the starting transform away from clamps. Zero vertical delta never changes scale. Normalize before preset routing so pan distances also have consistent units.

Zoom around the pointer in the drawing container's CSS coordinates. Preserve the drawing point under that pointer to within 0.5 CSS px in browser tests. Canvas DPR, paper-sheet scaling and axis mirroring must not alter the input coordinate frame. Consume events over the drawing only; inspector scrolling must remain usable and the underlying 3D viewport must not also navigate.

### Implementation seams

- Replace `useViewControls.ts`'s sign-only `wheelHandler` with a small independently testable delta/transform helper; mount the existing physical-modifier tracker with proper cleanup.
- Use `lib/navigation/presets.ts` for gesture policy. Adapt its pan result to drawing translation rather than copying a policy table or camera operations.
- Subscribe to navigation-preset changes; verify close/reopen and dock/float/pop-out do not leave duplicate listeners.
- Preserve Fit, pinned-view and sheet transform behavior. Canvas view scale must never change the sheet's specified drawing scale or exported geometry.

### Acceptance tests

1. Mounted real `useViewControls`: zero and horizontal-only events do not zoom; small deltas produce smaller changes than large deltas; equal opposite deltas restore scale and anchor away from bounds.
2. Equivalent normalized pixel/line/page inputs produce the same result. Exercise finite guards and both scale/change clamps.
3. Real keyboard Ctrl/Cmd press yields one-fifth logarithmic sensitivity; pinch without a key press does not; keyup and blur restore normal behavior, including focus in a markup editor.
4. Trackpad preset pans with plain scroll; Default horizontal scroll pans; Navisworks horizontal-only input does not zoom. Inspector wheel stays local.
5. Browser: Down, Front, Side, flipped and custom planes, sheet and non-sheet, docked/floating views. Validate anchor position using a real displayed geometric landmark, not only the zoom label.
6. Human device run: detented mouse plus macOS trackpad, and a Windows precision touchpad when available. Record device/preset and whether fine scrolling is controllable. Synthetic events alone do not close this criterion.

## #6615 A: projection depth and legibility

### Product behavior

The Projection control opens settings with an enable toggle and **View depth behind cut**: Auto or a finite non-negative distance in the selected display unit. Store manual distance canonically in metres. Auto preserves current behavior: vertical half-extent, existing plan storey scoping. Manual zero removes the background band while retaining the cut and the plan's separate overhead band; manual depth is not a model percentage and must not change when a distant federated model is added.

For Front/Side, project only the retained background half-space within the requested depth. The removed foreground must not appear. Flip reverses the physical retained side and continues measuring “behind” in viewing coordinates. A segment crossing the far-depth boundary is clipped to the band, not admitted whole merely because its mesh bounding box overlaps. Geometry crossing the cut still contributes its true cut.

Keep plan Auto storey behavior. Manual behind-cut depth replaces its retained-side band only; the plan's separate overhead convention stays as currently defined. Clearly label this in settings rather than implying a symmetric slab. Custom face-picked projection remains disabled in this slice with an explicit explanation; adding it requires its own agreed scope and fixtures.

Cut edges stay visually heavier than projected edges; background geometry is unfilled unless an existing style explicitly provides fill. Hidden Lines controls occluded projected edges; when disabled, genuinely hidden edges disappear. A window opening in a background wall must remain readable according to the actual mesh and visibility, rather than exposing all rear edges through opaque walls.

Depth is persisted with drawing options and captured/restored wherever projection options are saved (saved views / BCF / basket / drawing persistence: audit actual call sites). Older records missing the new field select Auto. Depth changes regenerate once after debounce; stale/cancelled generation cannot publish an older setting. Preserve current pan/zoom when only depth changes and pinned view is active.

### Implementation seams and risks

`useDrawingGeneration.ts` already calculates `projectionBelowDepth` and `projectionAboveDepth`; `packages/drawing-2d/src/projection-bands.ts` defines flip-adjusted signed depth and the plane basis. Add a single depth-policy resolver and feed existing generation configuration, bounds, edge filtering and hidden-line occluder inputs. The depth classifier and occluder raster must agree about the far plane. A UI field alone will not repair incorrect silhouettes.

Audit `drawing-generator.ts`, mesh outline classification and hidden-line raster clipping for whole-mesh/whole-contour admission. A bounding box that overlaps the band is only a broad-phase candidate, not proof that every emitted edge belongs inside it. Verify near-wall occlusion and window reveals separately from band culling before deciding whether a Rust meshing change is needed. Keep canonical mesh production shared if one is necessary.

Manual depth can be larger than the available scene; that safely includes the retained scene rather than rejecting a valid user value. Finite input validation rejects NaN, Infinity and negative values. Large depths must remain cancellable and bounded by existing generation budgets.

### Acceptance tests and visual oracle

Use an independently authored IFC wall with a real window/void, a near wall 2.5 m behind the cut, another object 6 m behind it, an opaque occluder and a foreground object. Record authoring tool/version and coordinates; include an independent expected section or oracle image. The current small demo is insufficient to prove this request.

1. At depth 2 m the 2.5 m wall is absent; at 3 m it appears with its correct window silhouette; the 6 m object stays absent; at 7 m it appears where unoccluded.
2. Foreground never appears. Flip uses the opposite physical side, with the same metric depth semantics. Repeat Front and Side.
3. Verify a long segment/triangle straddling the far plane is clipped, a near object occludes a far object, and disabling Hidden Lines removes occluded edges.
4. Changing depth does not change cut polygon area, entity selection identity, paper scale or original 3D geometry. Hiding/types/isolation gates apply equally to projection.
5. One-model and federated scenes, a distant site/proxy, rotated placement and georeferenced RTC origins preserve manual depth and global-id mapping.
6. Auto remains compatible with current plan storey tests, flipped plans and missing hierarchy. Manual zero, unit conversion, persistence migration, cancellation and stale-generation races get mounted behavior tests.
7. Browser export SVG/PDF/DXF agrees with the generated clipped lines; compare engineering landmarks/line visibility against the independent oracle.

## #6615 B: DXF placement in vertical sections

### Product behavior

Importing a DXF from a section offers **Site plan** or **Drawing reference** placement. A site plan retains existing IFC XY/georeference semantics. A drawing reference interprets the CAD's two dimensions as coordinates in the chosen section frame, with explicit units, scale, rotation and origin. Default to Drawing reference for Front/Side and Site plan for Down, showing the choice before committing.

Do not simply remove the `sectionAxis !== 'down'` guard: `DxfUnderlay` coordinates currently mean IFC XY with north-positive Y. Projecting these unchanged into an elevation would collapse or misplace a site plan. Preserve existing entries as site plans during migration. A section reference stores its engineering plane origin and orthonormal basis once; it follows its world placement instead of rotating itself into each newly active view.

Support Down, Front and Side initially. A planar reference naturally becomes edge-on in an incompatible view; show why it is unavailable. Sliding a parallel cut does not move the reference; Flip projects the same placement through the opposite viewing basis. Custom-plane rendering can reuse the basis projection, but custom placement UI is deferred unless explicitly included in the issue's agreed acceptance.

Offer Center on drawing, numeric offsets/rotation/positive scale, visibility, opacity and CAD layer toggles in all compatible sections. Center uses reference bounds in the same drawing coordinates as the cut; it does not alter scale. DXF unit conversion runs once. Blank/unknown-unit drawings request the unit; centering with no generated or reference extent explains the unavailable action.

World placement must use engineering precision and the established render-origin conversion. Georeference auto mode remains for site plans; a local elevation drawing does not inherit plan eastings/northings automatically. Selection and placement respect federation anchor changes; a frame mismatch must be reported rather than displaying plausible incorrect alignment.

### Implementation seams

Keep the existing DXF ingest/parser and layer data. Introduce explicit placement metadata in viewer state and versioned persisted data, keeping site-plan behavior intact. Route mapping through the established section basis helpers and render-frame transforms. Extend `useDxfUnderlaysForDrawing`, centering, inspector gating, screen/sheet renderers and export composition together. Source geometry remains immutable; rendering and export consume the same mapped data.

If a generic planar-reference placement type is introduced, put it alongside the established appearance reference infrastructure; DXF retains vector/layer semantics and PDF retains raster/lineage semantics. Do not squeeze PDFs into `DxfUnderlay` or create a second reference registry. Remove superseded mapping paths in the same implementation.

### Acceptance tests

1. Browser import a real CAD elevation DXF while Side is active; align two known landmarks, verify model/reference overlay and Center availability. Repeat Front.
2. Equivalent metre/mm/foot files produce the same engineering span. Unknown units, malformed/empty input and unsupported entities produce useful diagnostics.
3. Pan/zoom, section slide/flip, placement rotation, DPR and sheet mode preserve landmark registration. Layer off and opacity zero remove the rendered vector contribution.
4. Existing survey/site-plan georeference behavior survives migration, combined IFC+DXF drop, late anchor availability and RTC rebasing.
5. Restore placement after reload and model reopen; remove/reimport, duplicate files and interrupted loads have defined behavior. Underlay reference state must not become IFC geometry.
6. SVG/PDF and local section DXF exports show the same transformed lines. Vertical export must not label them as map-georeferenced XY coordinates.

## #6615 C: PDF reference workflow integration

### Product behavior

Underlays offers **Import PDF/image...** alongside DXF and lists registered raster references relevant to the current drawing. Open the existing Appearance reference workflow with reference intent and the current cardinal plane suggested: Down→IFC XY, Front→IFC XZ, Side→IFC YZ. Use existing source upload, page/crop/rotation/quality, two-point calibration, IFC-world placement, locking, opacity and Undo/Redo. Explicit confirmation commits registration; opening an import dialog does not change IFC appearance.

One selected PDF page creates one registered reference. Page count and page identity are visible. Calibration describes measured model distance, independently of paper dimensions, DPI, CropBox, UserUnit and page rotation. Invalid or coincident landmarks block placement. Changing a source page invalidates its draft calibration and does not repaint a committed reference. A later quality-only raster change preserves native document landmarks.

Registered pages render under cut geometry in compatible section and sheet views through the existing four-corner projection. Visibility and opacity are shared with the existing reference library. Edge-on and coordinate-frame mismatch states are explained in the Underlays list. The PDF does not become a set of IFC elements or snap-ready CAD vectors merely by import.

Reuse existing PDF limits (64 MiB input, 2,000 pages, 16 Mi pixels, 8,192 px dimension, 60 s task timeout), worker ownership and cancellation. Password errors, render failure and unsupported features use established diagnostics. Cancel/replacement/close releases provisional workers/assets; references retain their own committed asset leases.

Registration JSON already stores placement/digests/recipes without embedding images; expose this accurately and keep the existing relink flow. Do not promise automatic reload of PDF bytes or room sharing. Underlays is another view of existing references, not a new persistence system.

### Export contract

Choose and communicate this contract before implementation closes the issue: proposed scope includes PDF/image references in 2D SVG, PDF and Print. Embed the committed raster with its actual four-corner placement, crop, opacity and stacking order; sheet bounds and export use the same reference-aware layout as the canvas. Respect asset leases and document resource/pixel budgets.

DXF remains vector-only for PDF/image references in this slice. Show an omission notice listing the excluded reference count before export. Do not claim the raster was included or silently turn an engineering drawing into traced vectors. Exact PDF-to-IFC vector conversion is a separate existing workflow and not required to display a PDF underlay.

Current source inspection finds appearance references in the canvas and display bounds, but `useDrawingExport.ts` has no corresponding appearance-reference composition. Treat export fidelity as a required implementation audit; it was not validated by this browser run.

### Acceptance tests

1. From Side → Underlays import a multi-page architectural PDF; select the required page, calibrate a known 5 m span and place on YZ. It appears under the real IFC cut, with visible page identity and working hide/opacity/remove.
2. Repeat a rotated/cropped/UserUnit PDF and a scanned raster PDF. Measured span remains 5 m at different rendering quality and DPR; output uses the committed image, not the source's latest draft.
3. Exercise page change, cancellation, password-required/incorrect, corrupt input and over-budget page/file without phantom reference rows or leaked leases.
4. Fit includes references even with no cut polygons; parallel section movement preserves placement; incompatible/edge-on plane produces an explanation. Flip and sheet layouts preserve all four registered corners.
5. Close Appearance while the section stays open: committed page remains. Relink after registration import, edit/Undo/Redo and reference ownership remain consistent across both panels.
6. SVG/PDF/Print visibly contain the raster at correct engineering scale, opacity and crop. DXF omission notice is asserted through its actual export action, not a string search.

## Delivery and validation

Deliver #6614 separately from #6615. Within #6615, use stacked reviewable layers against the same issue if the diff grows beyond roughly 1,500 lines: depth/visibility, DXF plane placement, PDF workflow/export. Each layer states which acceptance it covers; the final layer closes the issue only when all agreed requests are demonstrated. A discovered unrelated silhouette defect needs its own scoped issue rather than an unbounded drawing sweep.

New behavior tests must mount real hooks/components and assert geometric/input invariants; no source-text assertions or set-state/read-back substitutes. Use root turbo entry points `pnpm typecheck` and `pnpm test`, with appropriate turbo filtering when narrowing scope. Read `.github/workflows/` and the live main ruleset before treating any gate list as complete.

Published `packages/drawing-2d` changes require a changeset, matching guide updates and an API-surface refresh if exports change. Viewer-only changes require no package changeset. Rust geometry/processing changes require `cargo test --workspace`, the exact workspace Clippy command from AGENTS.md, applicable wasm type regeneration, parity reference updates and both determinism manifests when output changes. Changes in perf-sensitive paths also require the ledger read and base/branch end-to-end perf verdict; do not use these tiny browser drawing timings as a geometry perf claim.

The implementation is reviewable when it carries: actual device input evidence for zoom; an authoring-tool IFC and independent wall/window section oracle for depth; real CAD DXF and architectural PDF landmark overlays; section/sheet export checks; mounted regression tests and root checks. This document and its recorded current-state browser run establish scope and reproduction, not passing future-feature acceptance.

## Full implementation plan

Implement the navigation fix first and deliver it against #6614. Build #6615 in three functional layers: bounded projection, vertical DXF references, and PDF reference integration with complete export handling. Each layer includes its own migrations, regression coverage and browser evidence. The existing analysis artifacts remain the baseline evidence; future runs record the exact local commit and build separately.

### Decisions for implementation

- Use the proposed wheel normalization and exponential sensitivity above as the initial behavior. Preserve existing navigation presets and physically held Ctrl/Cmd fine zoom. Physical-device feedback can tune the constant without changing gesture semantics.
- Represent projection depth as a viewer-owned discriminated choice, Auto or Manual with a finite distance in metres. Missing persisted values select Auto. Manual zero removes the retained-side background band while keeping the plan overhead convention; positive manual plan depth extends only the retained-side band. This matches the implemented depth policy.
- Preserve the existing Projection click toggle and add a settings affordance beside it or in the compact menu. Do not turn one-click toggling into an obligatory dialog. Commit valid depth changes through the same options update action.
- Give DXF entries explicit site-plan or plane-reference placement. A plane reference owns a frozen IFC Z-up origin, orthonormal U/V basis and frame identity. Existing DXF entries migrate to site-plan; their coordinate and georeference semantics do not change.
- Keep PDF/image references in `appearanceReferences`, with existing assets, calibration and history. Underlays reads and controls those records. Do not convert them into DXF state or introduce another registry.
- Include vector DXF references in SVG, PDF, Print and section DXF export. Include raster PDF/image references in SVG, PDF and Print; DXF explicitly reports their omission. Raw PDFs retain vector cut/annotation strokes while adding the raster underlay; sheet PDFs retain their existing raster-sheet policy.
- Limit new import placement controls to cardinal cuts. Existing custom-plane raster projection remains supported. Custom projection generation and custom DXF registration controls are separate work.

### Step 0 Prepare the local build and independent fixtures

1. Install with the pinned package manager and lockfile, build through root Turbo, and obtain the matching WASM runtime using the repository build script or its supported prebuilt fetch path. Record which runtime is used; prebuilt WASM cannot establish correctness of later Rust edits.
2. Fetch catalogued fixtures with `pnpm fixtures`. Start the local viewer through `pnpm dev`, using an unused port if needed. Confirm a real IFC loads through the canonical loader and that drawing generation is ready.
3. Establish fixtures for a wall/window at a measured 2.5 m background depth, a far object and an occluder; a real CAD elevation DXF; and an architectural PDF with a known span. Search the fixture catalog and existing independent references before generating new ones. Record provenance, units, landmarks and expected visible edges. Use the fixture manifest/upload process for model additions rather than committing IFC files.
4. Capture local baseline zoom inputs, projection configurations, DXF import eligibility, PDF registration and export contents. Keep synthetic line/box/control-PDF cases for mathematical invariants, and real authored files for user-visible acceptance.

Exit: reproducible local build and a fixture/evidence checklist. Missing author-provided ground truth does not prevent implementation or invariant tests, but wall/window visual acceptance stays open until an independent oracle is available. Do not manufacture an authoring-tool provenance claim.

### Step 1 Fix drawing navigation for issue 6614

Touch `hooks/useViewControls.ts`, a small drawing-navigation helper, `lib/navigation/presets.ts` integration, and the drawing hint catalogue. Reuse `components/viewer/wheelZoom.ts`'s modifier tracker without importing camera operations into the 2D transform path.

1. Normalize wheel units, resolve the current preset, and derive a finite scale/pan update. Apply horizontal pan and cursor-anchored zoom in one transform update when both are requested.
2. Handle zero deltas, non-finite inputs, minimum scale and bounded exponent changes. Validate container geometry before using pointer coordinates.
3. Create/dispose the modifier tracker with the drawing's actual owner window so a popped-out drawing tracks its own keyboard and blur events. Bind listeners to the current mounted container; avoid closing over a stale preset or retaining listeners after reparent/unmount.
4. Update contextual hints and preserve buttons, sheet scale and pinned-view transforms.
5. Add invariant tests for normalization and reversibility, then mounted hook tests for Ctrl/Cmd/pinch, presets, anchor preservation and listener lifecycle. Exercise dock/float/pop-out and inspector scrolling in the local T3 browser.

Exit: seven recorded failing baseline input cases behave correctly, rendered landmarks remain under the pointer, typecheck/tests pass through root Turbo, and physical-device acceptance is recorded or explicitly outstanding. Deliver a focused PR closing #6614 only after its required evidence is satisfied.

### Step 2 Implement projection settings and exact depth handling

Touch `drawing2DSlice.ts`, its persistence coalescer, `useDrawingGeneration.ts`, drawing toolbar/settings, and the necessary modules under `packages/drawing-2d/src`. Split new production logic into small modules rather than growing allowlisted files past their budgets.

1. Add the depth choice, validated action and legacy coalescing. Add the Projection settings affordance, selected-unit conversion, clear Auto behavior and disabled custom-plane explanation. Invalid drafts remain visible as invalid and never submit an earlier valid distance.
2. Extract the existing Auto band calculation into one resolver. Feed manual retained-side depth and explicit zero semantics into generation and include depth in debounce/dependency identity.
3. Audit projection consumers before changing geometry. `edge-extractor.ts` already clips segments using `clipSegmentDepth`; reuse it. `drawing-generator.ts` prefers `outlineProvider` whole-mesh contours, which cannot recover a partial-depth silhouette once 3D depth information has been discarded.
4. For meshes wholly within a band, retain the established outline path. For a mesh crossing a band boundary, clip transient mesh geometry in 3D before obtaining its winding-robust outline. Preserve normals, topology requirements and model/entity identity; do not mutate source meshes or silently switch to unreliable winding-based silhouettes. Reuse existing clipping machinery where its contract fits. If transient clipped meshes cannot provide the correct outline, extend the canonical Rust outline operation with explicit band inputs and regenerate its WASM boundary; validate both paths against the same geometric invariants.
5. Make profile-derived projections and hidden-line raster inputs honor the same band. The current occluder depth is the maximum of legacy and explicit depths; an unmodified legacy depth must not enlarge a manual background window. Clip crossing triangles rather than admitting a full occluder on one vertex overlap. Preserve Auto compatibility and opening/feature filtering.
6. Trace persisted drawing options and section snapshots. Extend drawing persistence and saved-view/basket restoration where they actually carry display options. Standard BCF clipping planes do not encode drawing depth: preserve standard interoperability and add an explicitly versioned application extension only through an existing supported extension mechanism. Otherwise document that BCF restores the cut while drawing depth remains a local setting; do not invent a standard BCF property.
7. Add boundary-crossing mesh/edge/profile and near/far occlusion invariants, mounted settings/regeneration/persistence tests, plus the independently authored wall/window browser oracle. Run tests with Auto and Manual, 0/2/3/7 m, both flips and one/N models.

Exit: settings actually bound geometry and occlusion; Auto preserves current accepted behavior; the independent wall/window section is demonstrated; cancellation does not publish stale results. Resolve the clipped-outline implementation before publishing the user control as complete.

### Step 3 Implement plane placement for DXF references

Touch DXF ingest, `DxfUnderlayState` and its persistence, `dxfUnderlayMath.ts`, `useDxfUnderlay.ts`, `useDrawingLayers.ts`, inspector controls and mapped underlay render data. Keep parsed vector/layer data and the original units separate from placement.

1. Add versioned site-plan/plane-reference placement, with old/missing records resolving to site-plan. Validate origin, basis orthogonality, scale, offsets and frame identity during import/restore. Share engineering-frame checks with the appearance reference runtime rather than creating another RTC-offset interpretation.
2. Resolve an explicit import context before reading files. Underlays imports may suggest the active section; generic Open/drop continues its current site-plan default unless the user explicitly chooses reference placement. Capture that context for the job so changing the section during asynchronous import cannot retarget it.
3. Route reference CAD XY through units and placement into frozen engineering U/V coordinates, then through the existing render-frame conversion and drawing projection. Apply unit conversion once. Keep source CAD layer data immutable and projection reusable by display/export.
4. Update Center, offsets, rotation, units and compatible-view status. Explain edge-on or frame-mismatched references. Remove obsolete plan-only gating only where explicit plane placement makes the mapping valid.
5. Preserve independent 2D/3D visibility. For a vertical reference visible in 3D, emit line geometry on its registered plane rather than the old horizontal flattening. Preserve the existing 3D opacity limitation unless the renderer is deliberately extended and tested in scope.
6. Cover migration and units with transformed-landmark invariants; mount import/centering controls and verify real CAD geometry on Front/Side. Include survey georeference, late model load, flip, RTC rebase, frame mismatch and reload cases.

Exit: real elevation DXF renders and centers in the correct plane, existing site plans retain their alignment, and references preserve engineering placement across display changes. Vector export inclusion completes in Step 5.

### Step 4 Connect PDF references to the Underlays workflow

Touch `DxfUnderlayPanel.tsx` or a small shared Underlays wrapper, `DrawingInspector.tsx`, `AppearancePanel.tsx`/controller entry context, and reuse the existing `AppearanceReferenceLibrary`, `useReferenceAppearance`, `usePdfAppearanceSource` and `useReferenceImagesForDrawing`.

1. Add Import PDF/image and an entry-context action that opens Appearance with reference intent and the active cardinal plane. Set the context before upload begins; changing Appearance intent cancels its pending draft today. Consume the entry request once, and keep it distinct from saved user draft state.
2. Bind PDF/image rows directly to existing committed references and their history actions. Provide page identity, visibility, opacity, edit, remove and unavailable-frame/edge-on status. Existing Appearance library and Underlays must immediately reflect each other's actions.
3. Keep one calibration flow and one asset ownership lifecycle. Reuse crop/page/rotation/password/quality controls; preserve native PDF landmarks and existing immutable committed-reference behavior. No automatic IFC authoring or mutation-mode requirement for placement.
4. Include references in the drawing bounds and Fit through the existing derived drawing hook. Verify pin behavior, parallel cut movement, sheet layout, close/reopen and missing asset relinking.
5. Mount the actual import entry and reference rows; test intent-before-upload, invalid calibration, cancellation, page changes and source replacement. Run the complete local Side→Underlays→PDF→5 m calibration workflow with a real architectural page and the existing rotated control PDF.

Exit: users can discover, place and manage PDFs from a section without a duplicate source/library. Existing raster registration, history and lease tests stay green. Export acceptance completes in Step 5.

### Step 5 Complete display and export composition

Touch `useDrawingExport.ts` through extracted composition helpers, `useDrawingLayers.ts`, `DrawingExportMenu.tsx`, `drawing-export-omissions.ts`, sheet composition and published exporter modules only as needed.

1. Build one immutable export snapshot containing the generated drawing, reference-aware display bounds, mapped DXF vectors, projected committed raster corners, markup and frozen sheet/pin layout. Hold required asset leases for asynchronous export and release them in `finally`; source changes/removal during export must not substitute a newer image or leak resources.
2. SVG: embed committed raster bytes, apply the same two-triangle affine mapping/clipping as the canvas for four-corner geometry, preserve opacity and order, and place vector DXF underlays beneath cut geometry. Use owned data URLs, existing escaping and download helpers.
3. Raw PDF: compose raster references and DXF vectors through the established world-to-page mapping before the vector cut strokes. A valid non-rectangular reference requires clipped affine triangles or a bounded precomposited raster layer, not its axis-aligned bounding box. Preserve physical paper dimensions and drawing scale; bound raster intermediates with the existing limits.
4. Sheet PDF and Print: feed the same reference-inclusive sheet SVG/layout. Retain the established sheet rasterization/capping diagnostics and current markup policy. Do not silently rasterize the raw vector PDF's entire drawing as a shortcut.
5. DXF: append mapped DXF vector entities using the same local section basis and unit convention as model lines. Report PDF/image omissions by visible eligible raster count; adapt the existing omission helper with distinct vector/raster content counts. A hidden, zero-opacity or unavailable reference does not trigger a false omission. Remove underlay omission warnings only for formats that now include them.
6. Compare browser downloads for raw and sheet layouts, each with vector-only, raster-only and mixed references. Validate known distances, corner placement, opacity and hidden layers; render/inspect exported PDFs, parse exported DXFs, and inspect SVG image/vector placement. Mount the real export menu to assert the DXF omission notice and cancel/continue behavior.

Exit: SVG/PDF/Print agree with the section display at engineering scale, vector DXF references survive DXF export, and raster exclusions are accurate and explicit. The PDF claim requires inspecting the downloaded artifact, not only its preview.

### Step 6 Validate and deliver both issues

For each functional layer, run targeted tests through the root Turbo entry points and run root typecheck. At final integration run `pnpm typecheck`, `pnpm test`, `pnpm lint` and the relevant documentation/generated-surface checks from current workflows. New tests cite the issue and exercise actual behavior. Do not add a source-scanning test or a CI gate without workflow wiring.

If Step 2 changes Rust or a perf-sensitive path, read the perf ledger first, run the workspace Rust tests and `cargo clippy --workspace --all-targets -- -D warnings`, regenerate public WASM types through `scripts/build-wasm.sh`, and run the applicable WASM contract, parity and determinism checks. Measure base/branch end-to-end worker-pool performance with the required fixtures, record geometry identity or legitimate output changes, and write the perf verdict in the repository ledger. No Rust change means no invented Rust/perf work requirement.

Update the drawing and Appearance guides and input help with final behavior. Published package changes carry a changeset and intentional export changes refresh the API snapshot. Keep new production modules below 400 lines and remove replaced paths.

Record browser evidence from a fresh local tab: exact commit, WASM/runtime provenance, input cases, fixture provenance, landmark/section comparisons and export artifacts. Recheck the hosted browser only after release if deployment validation is requested; a hosted baseline cannot validate unshipped code. Preserve acknowledged manual/device and independent-oracle gaps in the review description.

Read the issue-queue script's reported mode before PR creation. The main ruleset inspected on 2026-10-01 requires `Build + WASM + Rust + Node`, `Issue queue`, `PR review signal`, and `parity (in-tree fixtures, committed reference)`; re-read it at delivery because configuration can change. Keep PRs focused by issue, stack #6615 layers if needed, and close #6615 only after depth, DXF and PDF/export acceptance is demonstrated. Register each created/worked PR with T3 linking tools when available. This planning task does not create PRs or publish changes.

### Execution order and remaining uncertainty

| Work | Dependency | Completion evidence |
| --- | --- | --- |
| Local build and fixture preparation | None | Reproducible local baseline and provenance |
| Drawing navigation | Local build | Input invariants, local browser and device run |
| Projection depth and clipping | Independent geometry invariants; visual oracle for closure | Near/far boundaries and window/occlusion comparison |
| DXF plane references | Local build and CAD landmarks | Placement, migration, RTC and 2D/3D overlay |
| PDF Underlays integration | Existing reference controllers | Complete import/calibrate/manage browser workflow |
| Export composition | DXF placement and raster list integration | Downloaded mixed-reference SVG/PDF/DXF and Print |
| Final delivery | All acceptance and current required gates | Two issue-focused deliverables and recorded limitations |

The main technical uncertainty is partially clipped winding-robust outline generation. The main evidence gap is an independent expected wall/window section. Resolve these early; they determine whether #6615 requires a Rust boundary change and whether its visual defect is demonstrably fixed. DXF and PDF integration can continue while that oracle is obtained. Implementation estimates should follow the clipped-outline investigation, rather than assume all three improvements are UI-only.

## Implementation status (2026-10-01)

The working tree now contains wheel-delta navigation with preset behavior and
cursor anchoring; persisted Auto/manual projection depth and exact band clipping;
frozen engineering-plane DXF registration with validated persistence, import
units, 2D/3D projection and compatible-view centering; and the Drawing Underlays
entry into the existing PDF/image reference workflow. Mapped vector/raster bounds
feed Fit and sheet layout without changing stored generated geometry.

The export implementation composes mapped DXF vectors and committed raster
references in SVG/PDF/Print and appends the vectors to section DXF output. The
DXF omission flow now distinguishes raster references from included vectors.
The matching guide describes the new controls and the optional SDK
`clipProjectionBands` contract, and a drawing-2d patch changeset records it.

Regression coverage includes mathematical clipping/placement invariants,
mounted wheel and Underlays workflows, registered-plane hook rendering, and
reference-aware bounds. Final root checks and browser/download evidence are
recorded separately by the integration run. This status records implemented
paths; it does not substitute for the independent IFC/CAD/PDF acceptance oracles
listed above.

The integration run and retained artifacts are documented in
[browser and export evidence](evidence/section-6614-6615/README.md). Real Archicad
geometry demonstrated stable cuts and changing projection bands at 0/3/7 m;
downloaded mixed-reference raw and sheet PDFs were rendered and inspected.
Artifact inspection found and corrected the existing raw PDF double Y inversion.
The broad viewer suite's remaining authored-mesh failure reproduces on the clean
base commit under the same Node 22 runtime; focused section tests are green.
Physical input-device and independent architectural/CAD alignment oracle gaps
remain explicit in that evidence.

Current validation: root drawing-2d tests pass all 560 tests, and root
`pnpm typecheck` covers all 3,203 test files. The integration artifacts predate
subsequent source refinements and do not establish a browser run of the final
submitted commit. The historical Node 22 authored-mesh failure and the physical
input-device and independent-oracle limitations remain documented in the
[evidence record](evidence/section-6614-6615/README.md).

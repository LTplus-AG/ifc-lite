# Multiple cutting planes

Status: in implementation (stacked PRs against #7545). Where the code departs from this text the departure is listed under "As built" at the end.

Issue: [#7545 — Multiple cutting planes with numeric offset, flip, set view and exact zoom](https://github.com/LTplus-AG/ifc-lite/issues/7545). Carries `ready`; claimed by session `0d879cc0`. Source baseline for every code reference below: `7a90ee4900` on `main`.

## What the issue asks for, against what exists

The viewer already has one section plane with most of the single-plane controls. The work is mostly **N planes**, plus five small controls. It is not a new section feature.

| Request in the issue | Today | Gap |
| --- | --- | --- |
| Add multiple planes, X/Y/Z or from a face/object, each named A, B, C… | One plane: `ViewerState.sectionPlane`. Cardinal (`axis` + `position`), face-picked (`custom`), box (`box`), alignment-bound (`custom.alignment`) | **Plane set, names, add/remove.** Renderer, pickers, shadow pass, point clouds, caps and every reader assume one plane |
| Plane selector | None | New |
| Numeric offset in model units | `HudValueField` in `SectionToolbar`: click to type, arrows step, drag scrubs. Value is metres (`useSectionDistance`) | Display in the project length unit; typed entry already works |
| Step size, mouse wheel | Fixed per kind: `step` 0.1 cardinal, 0.05 custom, in `useSectionDistance`; Shift multiplies | **Configurable step; wheel stepping.** `HudValueField` has no wheel handler |
| Show (the plane itself) | Gizmo quad draws whenever a plane is handed to the renderer (`render-section-draw.ts`), and while the tool is open for a disabled plane (`section-render-clip.ts`, #6374) | **Per-plane gizmo visibility**, separate from "cutting" |
| Flip | `flipSectionPlane`, `SectionToolbar` flip toggle | Per plane (falls out of the plane set) |
| Set view | `presetViewForAxis` (`sectionConstants.ts`) backs the Drawing header's "Match 3D" for cardinal planes only | **Set view for any plane**, including face-picked, from the toolbar |
| Remove / Clear all | `setSectionPlaneEnabled(false)`, `clearSectionCut` (clears one cut) | Per-plane remove, Clear all |
| Cut vs Section | `Cut` toggle clips the 3D view; `2D`/Drawing toggle opens the Section drawing | Mapping only — see "Cut and Section", no new mode |
| Fill slice | `showCap` + hatch/colour (`SectionCapControls`); cap is the 2D cutter's polygons drawn by `Section2DOverlayRenderer` | **Caps for every enabled plane**, not only the active one |
| Plane preview | A disabled plane draws as a translucent quad while the Section tool is open | Per plane (falls out of the plane set) |
| Exact zoom, saved with the planes | `frameSelection`, `selectionBounds`, `frameBuildingExtent`; `BasketView` stores `viewpoint` + one `SectionPlane`; `savedSectionCutsStore` stores one plane; BCF carries `clippingPlanes[]` but the viewer reads and writes only `[0]` | **Frame-with-margin, and a saved set that holds N planes, the zoom and the camera** |

The reference tool's behaviours that the issue names are all specified below; nothing here depends on anything outside the issue text and the screenshot.

## Decisions

### D1. The plane set is "active plane + inactive planes"

`sectionPlane` stays, and means **the active plane**. A new `inactiveSectionPlanes: SectionPlane[]` holds the rest.

Why: about ninety files read `sectionPlane`. Most of them want *the one cut a drawing, a PDF sheet, an alignment, a floor plan or a BCF snapshot is about*, which is the active plane by definition. Replacing the field with an array would touch all of them for no behavioural gain and would put N=1 behaviour at risk. Under this design every existing writer (`setSectionPlaneAxis`, `setSectionPlanePosition`, `flipSectionPlane`, `setSectionPlaneFromFace`, `setSectionBox`, `setSectionCapStyle`, …) edits the active plane exactly as it does now, and N=1 is the current program, unchanged.

- `SectionPlane` gains `id: string` and `name: string` and `showGizmo: boolean` (default `true`). `id` is a monotonic session counter, never reused, never shown. `name` is user-visible.
- `activateSectionPlane(id)` swaps the active plane with the named inactive one, in one `set`. It is the only way the active plane changes identity.
- New readers: `allSectionPlanes(state)` (active first, then inactive in creation order) and `clippingSectionPlanes(state)` (the subset that is `enabled`, honouring `sceneState.section.visible`). `activeSectionPlane()` keeps its meaning.
- Hard limit `MAX_SECTION_PLANES = 8`. "Add plane" is disabled at the limit with a visible reason.
- Names: `A`…`Z`, then `A2`…`Z2`; the next unused name. Rename is free text, trimmed, 1–24 characters, unique case-insensitively (a clash gets a numeric suffix rather than an error).
- Section box (`box`) stays a mode of the active slot, as now. Inactive planes keep clipping while a box is active; the renderer already clips with a plane set and a clip box independently. Entering box mode no longer implies "one cut".

### D2. Semantics: the kept region is the intersection

A point survives only if **every** enabled plane keeps it. This is already what `sectionClipped` does for one plane plus a box (any test says "clipped"), so a set is the same rule extended. Flip is per plane. There is no union mode and no per-plane "boolean" setting; if a union is ever wanted it is a new issue.

### D3. Renderer ABI: the first plane keeps its slot; extras go in a shared uniform

The per-mesh uniform (`MESH_UNIFORM_FLOATS = 96`, `mesh-rte-uniforms.ts`) is one block per batch bind group and carries plane 0 and the clip box. It is **left byte-identical**. Planes 1…7 go in one new frame-level uniform shared by every draw: a `count`, and for each extra plane a `vec4` (normal, distance) plus a flipped bit, packed twice — world-space and camera-relative (RTE). The shader picks the RTE copy through the existing `RTE_DRAWABLE_FLAG`.

Why not widen the per-mesh block: it costs 112 more bytes on every draw to serve a feature most scenes do not use, and it changes the ABI that `mesh-uniforms-struct.test.ts` and the RTE packers pin. Why a frame-level block works at all: the RTE conversion `rtePlaneDistance(distance, normal, eye)` depends on the camera only, not the drawable, so it is computed once per frame in f64 (the guarantee #5049 exists for) and shared.

A **Layer 1 spike decides the bind-group placement** (a new group, or an added binding in an existing group) by measuring against the pipeline layouts; the packer API and the WGSL function `extraPlanesClipped(p)` are the contract, the group index is not. At `count = 0` the loop does nothing, which makes "N=1 renders identically" a testable claim (below).

All eight clip sites must change together, or picking and drawing disagree (the class #5390's shared `sectionClipped` was introduced to prevent):

| Site | File | Note |
| --- | --- | --- |
| Main fragment + selection-mask fragment | `shaders/mesh-uniforms.wgsl.ts` (`sectionClipped`) | One edit serves both |
| Shadow pass | `shaders/shadow.wgsl.ts`, `shadow-pass.ts` | Own clip uniform; shadows must come from the clipped model |
| GPU picker, two shaders | `picker.ts`, `pick-uniforms.ts` | Own clip uniform |
| CPU raycast | `scene-raycaster.ts` (`pointClipped`, `boxFullyClipped`, `clipIsActive`) | `PickClipState` gains `extraPlanes`; `boxFullyClipped` is per plane |
| Source curves | `source-curve-clipping.ts` | Per-plane parametric intervals, intersected |
| Point clouds | `pointcloud/point-cloud-uniforms.ts`, `point-shader.wgsl.ts` | Own uniform |
| Section cap | `shaders/section-2d-overlay.wgsl.ts` | See D4 |

`RenderOptions` gains `extraSectionPlanes?: ClipPlaneState[]` (normal, distance, flipped; no cap or gizmo data). `sectionPlane` stays the primary plane and keeps driving the gizmo and the cap.

### D4. Caps for every enabled plane; a cap is clipped by the other planes

The cap is today the 2D cutter's polygons for the *active* plane (`useRenderUpdates.ts` → `uploadSection2DOverlay`), generated by the Drawing hook. For a set:

- Each enabled plane gets its own cap geometry, generated by `cutMeshesStreaming` (`packages/drawing-2d`) with that plane's config, **off the main thread**, debounced (120 ms) and invalidated only by that plane's own geometry change (offset, flip, face, source model). The active plane's cap continues to come from the Drawing hook so the 2D and 3D caps stay one computation.
- `Section2DOverlayRenderer` holds geometry per plane id. A cap fragment is discarded if any **other** plane clips it (the shader gets the same extras block and skips its own index). A cap polygon of plane A that lies in plane B's removed half-space must not draw; doing this in the shader avoids clipping polygons on the CPU.
- While a plane is being scrubbed its cap may lag one debounce; the clip is always exact. This is the same trade the existing scrub already makes (`setPointCloudPreviewStride`).
- Cap style stays one global style (`SectionCapStyle`, persisted in `localStorage`). Per-plane cap style is not requested; it is explicitly out of scope.

Perf is a gate, not an aside: the PR must show frame time and cap-regeneration time with 1, 4 and 8 planes on `AC20-FZK-Haus.ifc` and one heavy model, base against branch, per `AGENTS.md`'s perf rules.

### D5. Units: the store is metres, the field speaks the project unit

World units are metres (geometry is unit-scaled at parse). The offset field shows and accepts the **project length unit** (via `lib/units`), with metres as the fallback when the file declares none; the unit label is the field's `[m]` in the screenshot. The store, saved sets, BCF and SDK all hold metres. A typed value is converted once, on commit. The step is held in the same unit the field shows and converted the same way. For a federated scene the unit is the first visible model's, the rule `resolveListColumnUnits` already uses.

### D6. Cut and Section

No new mode. `Cut` is the existing Cut toggle (3D clipping, per plane). `Section` is the existing Drawing/2D toggle, which opens the 2D section of the **active plane**. A 2D drawing is about one plane at a time; with several planes the Drawing header names the active plane and follows `activateSectionPlane`. If the reference tool's "Section" is meant to mean something else, that is a question for the issue author — see Open questions.

## Behaviour

### Plane set

| Action | Result |
| --- | --- |
| Add plane ▸ X / Y / Z | New plane through the middle of the model along that axis, named next, becomes active, `enabled`. Menu labels pair the viewer's axis names with the IFC axis (Side = X, Front = Y, Down = Z) so the issue's X/Y/Z maps unambiguously |
| Add plane ▸ Face | Arms face-pick with `sectionPickTarget: 'new'`. The commit **adds** a plane (today it replaces the active one); the existing hover preview, inset (`facePickInset`) and camera-oriented normal are unchanged. Esc disarms |
| Add plane ▸ From selection | Needs a decision, see Open questions. Default proposed: an axis-aligned plane at the selection bounds face nearest the camera, from `cameraCallbacks.selectionBounds()` |
| Plane ▾ | Lists every plane: name, axis/face label, offset, cutting dot, eye (Show) toggle. Selecting activates. F2 or double-click renames |
| Remove | Removes the active plane; the previous plane in the list becomes active; removing the last leaves the tool open with no plane, as a fresh open |
| Clear all | Removes every plane. One undo-style toast restores them (the previous set is kept until the toast closes) |
| Show | The active plane's `showGizmo`. Independent of `enabled`: a plane can cut without showing its quad and show without cutting |
| Cut toggle | The active plane's `enabled`. `sceneState.section.visible` stays the one global hide, and the HUD chip (`SectionParkedChip`) reads "N cuts" |
| Flip | The active plane's `flipped`; the face-pick rules for `cardinalSectionFlipped` (#5644) are untouched |
| Alignment-bound planes | `custom.alignment` stays a property of its plane. A bound plane keeps its station binding while inactive; editing any plane's offset by hand detaches only that plane (`alignment: undefined`, as today) |

### Offset, step, wheel

- The field commits on Enter/blur, clamps to the axis range (cardinal) and is unbounded (custom), exactly as now. Invalid input reverts to the last value and does not touch the store.
- **Step** is a per-user preference in `localStorage` (`ifc-lite:section-step`, default 0.1 m), a small menu next to the field offering 1 cm, 5 cm, 10 cm, 25 cm, 50 cm, 1 m and a custom value. It replaces the hard-coded `step` in `useSectionDistance` for cardinal and custom planes. Shift keeps its multiplier (×10); Alt/Ctrl divides by 10.
- **Wheel**: over the field, one wheel notch moves one step (sign of `deltaY` only, so `deltaMode` needs no normalising; `wheelZoom.ts` does not normalise it either); the page and the 3D camera must not also scroll or zoom (`preventDefault` on a non-passive listener). Magnitude is ignored on purpose, so a trackpad cannot fire fifty steps. Wheel is inert while the field is being typed into.
- Storey snaps (`snaps`) apply to scrubbing only, as now; a typed value, an arrow key and the wheel are the precise paths.

### Set view

`Set view` aligns the 3D camera to look **perpendicular to the active plane at the kept side**: for a cardinal plane the preset from `presetViewForAxis(axis, flipped)`; for a face-picked or alignment-bound plane a viewpoint looking along `-normal` (or `+normal` flipped), from a distance that frames the cut region, with `up` the plane's `bitangent`. The camera animates with the existing transition. This needs one new `CameraCallbacks` entry, `lookAlong(direction, up?, bounds?)`, unless an equivalent turns up during Layer 2; do not add a second mechanism next to `setCameraRotation` and `setPresetView` without checking.

### Exact zoom

```ts
interface SectionZoomSpec {
  target: 'selection' | 'cut-region' | 'model';
  /** Extra room around the target. A fraction of its largest extent (0.10 = 10 %) or an absolute length in metres. */
  margin: { kind: 'fraction'; value: number } | { kind: 'metres'; value: number };
}
```

`cut-region` is the AABB of the model bounds clipped by the enabled planes (a convex-polytope clip of eight corners against at most eight half-spaces; no mesh work). `selection` is `cameraCallbacks.selectionBounds()`. The camera keeps its current direction and projection; it frames the target with `margin` applied, in perspective by distance and in orthographic by `orthoSize`. A new callback `frameBounds(bounds, { marginFraction | marginMetres }, durationMs)` serves both; `frameSelection` and `frameBuildingExtent` stay as they are and may be rebuilt on it later, not in this issue.

UI: a "Zoom" popover on the bar with the target, the margin (percent or length) and a "Zoom" button, remembering the last used spec per session. The reference tool's "zoom to selection + 10% margin" is `{ target: 'selection', margin: { kind: 'fraction', value: 0.1 } }`.

### Saved sets

One saved record holds everything that makes the view repeatable:

```ts
interface SectionSet {
  id: string; name: string;
  planes: SavedSectionCutPlane[];   // geometry + cap flags only; no enabled/parked
  activeIndex: number;
  zoom: SectionZoomSpec | null;
  viewpoint: CameraViewpoint | null; // the exact camera, so "restore" is not "re-frame"
  createdAt: number; updatedAt: number;
}
```

- `savedSectionCutsStore` becomes `SectionSet`s. A saved cut with one plane is a set of one, so the existing Drawing-panel list, rename and delete keep working. Applying a set replaces the whole plane set (active + inactive), un-hides, opens the tool, and then either re-applies `viewpoint` (if present) or runs `zoom`.
- `BasketView.section` (`BasketSectionSnapshot`) stores the plane set instead of one plane; `captureSectionSnapshot` and `basketViewActivator` follow.
- **BCF**: a viewpoint exports every enabled plane as an entry of `clippingPlanes[]` (the schema is already a list); import reads all of them and restores the set, not `[0]`. Round-trip through `sectionPlaneToClippingPlane` / `clippingPlaneToSectionPlane` (`packages/bcf/src/viewpoint.ts`) is per plane. Names have no BCF slot; they are lost on export and regenerated A, B, C on import, and the spec says so rather than inventing an extension. A viewpoint with more than `MAX_SECTION_PLANES` planes applies the first eight and warns.
- **SDK** (`bim.viewer`): `getSection()` / `setSection()` / `clearSection()` keep their single-plane meaning and act on the active plane. Add `getSections()`, `setSections(planes)`, `addSection(plane)`, `removeSection(id)`. The sandbox bridge schema, `bim-globals.d.ts` (`pnpm generate:bim-globals`) and the API-surface snapshot move together, with a changeset.
- Persistence: sets live in memory for the session, like the stores they replace. Cross-session persistence is an open question below; BCF is the portable path today.
- The scene-action session (`scene-session.ts`, `scene-restore.ts`) records `section.prior`/`installed` as one `SectionPlane` by reference. It becomes the whole set; the "was it changed since" test compares the set object, which every section write already replaces.

### What reads which

Layer 1 produces a ledger (`docs/architecture/evidence/section-7545/readers.md`) listing every non-test reader of `sectionPlane`, `activeSectionPlane`, `sectionRenderClip`, `PickClipState`, `gridSectionClip` and `getSection`, each tagged **active** (a drawing, alignment, floor plan, PDF sheet, the 2D DXF reference: unchanged) or **clip set** (changes). Known clip-set readers before the audit: `viewport-render-options.ts` / `section-render-clip.ts`, the pick clip built for `useMouseControls` and `selectionHandlers`, `Viewport.tsx`'s `gridSectionClip` (down-axis band only), `generate-view-pdf.ts` (the PDF's 3D view should clip like the screen), `useScanSectionLayer.ts`, `space-envelope.ts`. Anything the audit finds that is not on this list is added to the ledger before it is changed, not after.

## UI

The Section bar is a `HudToolbar` whose forms already degrade by tier (`useHudBarTier`, #6315). The new arrangement, left to right, follows the screenshot's "Cutting planes" group:

```
✂ SECTION │ [+ Add plane ▾] │ Plane [D ▾] [Remove] │ Offset [ -0.200 ] [m] [10 cm ▾] │ [⇅ Flip] [Set view] [Clear all] │ [☐ Show] │ Cap ▾ │ ◉ Cut │ Zoom ▾ │ 2D │ ✕
```

- The current axis segmented control (Down/Front/Side/Face/Box/Alignment) becomes the **Add plane** menu plus a per-plane "mode" shown in the Plane list; changing an existing plane's mode is "Reset to axis" and face re-pick, both kept. This removes the only place the bar could be misread as "one plane".
- New tier order when the lane is narrow: caption, then Zoom, then Clear all, then Set view move into an overflow popover; Plane, Offset, Flip, Cut and close never overflow.
- Every control has a visible label or `aria-label`, every new string a catalogue key in `i18n/catalogues` (`en` plus the lazy catalogues the i18n tests enumerate), and every new tour anchor goes through `lib/tours/anchors.ts`.
- Keyboard: `[` / `]` previous/next plane, `Alt+Wheel` steps the active plane's offset while the pointer is over the canvas (off by default; discoverable in the shortcuts dialog), Delete removes while the plane list has focus.
- The plane quads are drawn in one accent, with the **active** plane brighter and the others dimmed, and a name tag at each quad's corner so "D" is findable in the scene. Tag text is DOM overlay (as `SectionVisualization` already does for the pick preview), not a texture.

## Layers

This exceeds the repository's ~1,500-line guidance, so it ships as stacked PRs against #7545. Each layer is demonstrable alone and leaves N=1 unchanged.

| Layer | Scope | Demonstrable result |
| --- | --- | --- |
| **L1 Plane set and clipping** | Store (D1, names, add/remove/activate, Clear all), `MAX_SECTION_PLANES`, renderer ABI spike then D3 across all eight sites, reader ledger, plane list + Add plane (X/Y/Z/Face) in the bar. No caps for inactive planes yet; the active plane's cap and drawing are untouched | Two or three planes cut an authored model; the GPU picker, CPU raycast, outline and shadow all agree; one plane renders bit-identically to `main` |
| **L2 Offset and plane controls** | Step preference and menu, wheel stepping, project-unit field (D5), Show, Set view, `lookAlong`, per-plane flip/Cut, rename, keyboard | Type −0.200 m, wheel in 10 cm steps, Set view for a face-picked plane |
| **L3 Caps and drawings** | D4 caps for every enabled plane, cap-vs-other-plane clipping, Drawing header names/follows the active plane, PDF view export clips the set | A three-plane section with all caps and no cap drawn in a removed region |
| **L4 Zoom and saved sets** | `frameBounds`, `SectionZoomSpec`, `SectionSet`, basket/BCF/SDK round-trip, scene-session restore | Save a set with a zoom, change everything, restore it; BCF round-trip with three planes |

Order is fixed: L1 before everything; L2 and L3 are independent of each other; L4 needs L1 and uses L2/L3 only for tests. If L3's perf gate fails, L1 + L2 + L4 still ship with caps on the active plane only, and the gap is recorded on the issue.

## Acceptance

The issue's five boxes, each made testable. Component tests mount the real components against the real store (`@/test/render.js`, recipe in `AGENTS.md`), not mocks, and every regression test names #7545.

1. **Multiple named planes can be added and removed.** Mounted `SectionToolbar`: click Add plane ▸ Z, Y, Face (click the picked face on a real fixture) — three planes A, B, C; Remove the active one — the previous becomes active; Clear all then undo restores all three; at eight planes Add is disabled with its reason visible. Rename "B" to "East wing"; a duplicate name gets a suffix.
2. **Typed and stepped offset.** Type `-0.2` into the field with the project unit set to metres, then to millimetres (`-200`): the store holds −0.2 m in both. Wheel one notch at 10 cm → exactly 0.1 m; at a custom 7 mm step → 0.007 m; the 3D camera does not move (assert its state is unchanged). Garbage input leaves the store untouched. Shift/Alt multipliers.
3. **Flip and Set view per plane.** Two planes, flip one: the kept half-space of the other does not change (assert by sampling points through the same predicate the shader mirrors; see the parity test). Set view on a cardinal plane yields the `presetViewForAxis` direction; on a face-picked plane the camera's forward vector equals `∓normal` within 1e-6 and its `up` is the plane bitangent.
4. **Fill slice and plane preview.** Each enabled plane has a cap; a cap fragment lies only where all other planes keep it (sample the cap geometry against the other planes' predicate). A disabled plane shows its quad while the tool is open and stops when it closes (#6374 preserved); Show hides the quad without ceasing to cut.
5. **Exact zoom; view and planes saved and restored.** Frame `selection` with 10 % margin: the camera's frustum contains the selection's bounds and the margin is within 1 % of 10 % of its largest extent (assert on the view-projection, not on a constant). Save a set, change every plane and the camera, apply it: planes (id-independent), active plane, zoom spec and camera round-trip exactly. BCF: export three planes, import in a clean store, same three half-spaces.

Cross-cutting tests that guard the design rather than a box:

- **Renderer/picker/cap agreement.** One shared fixture of planes and points; the WGSL `sectionClipped` equivalent, `pointClipped`, the picker's and the shadow pass's predicate are evaluated on the same 10,000 seeded points and must agree (a TS port of each shader's arithmetic; the shaders themselves are string-built, so also assert in the existing `renderer-render-paths` style that every site's WGSL contains the single shared function, by compiling it, not by grepping source).
- **N=1 is `main`.** With one plane, the packed mesh uniform and the new extras block's `count` produce the same bytes as `main` for the existing RTE and non-RTE cases (`section-plane-rte.test.ts`, `mesh-rte-uniforms.test.ts` stay unchanged and green).
- **RTE at scale.** Three planes on a model georeferenced to ~5,000 km: cut boundaries within a centimetre of the f64 truth, as `section-plane-rte.test.ts` already requires for one.
- **Concurrency of the stores.** Activating, removing and adding while a face pick is armed, while a BCF viewpoint is applied, and while a saved set is applied never leaves two planes with the same id, an `activeIndex` out of range, or an enabled plane the renderer was not told about.

## Evidence the PR must carry

Per `AGENTS.md`, a PR claiming user-visible behaviour shows it:

- An **authored** IFC model (from a real authoring tool, not generated by this repo's creator) loaded in the browser with three planes: floor, a wing and a face-picked plane, with screenshots of the cut, the caps, and the plane list. WSL Playwright has no WebGPU; use the real-GPU path (Windows Chrome over CDP) as in the project's perf harness, otherwise the 3D canvas is empty.
- The BCF export of that scene, opened in a second BCF-aware viewer or at minimum re-imported here.
- The perf table from D4.
- The reader ledger from Layer 1.

## Out of scope

Per-plane cap styles; a union (OR) of planes; planes in the 2D drawing's own coordinate system; section planes as persisted IFC entities (`IfcPlane`/`IfcHalfSpaceSolid` authoring); saving across sessions beyond what Open question 3 decides; more than eight planes; animating a plane through its range (a "sweep"). Each can be a follow-up issue if wanted.

## Risks

- **Shader and picker drift.** Eight sites is the whole risk of D3. The parity test is the control, and the single WGSL function is shared wherever the file layout lets it be.
- **State drift between `sectionPlane` and the inactive list.** `activateSectionPlane` is the one swapper and is tested against every writer; no code writes `inactiveSectionPlanes` except the slice.
- **Cap cost.** N cutters on a heavy model. Mitigation is the debounce, the worker, the eight-plane limit and the perf gate; the fallback is active-plane-only caps.
- **Module budgets.** `sectionSlice.ts` and `store/index.ts` sit at their `check-module-size` ratchet (see the comments in `savedSectionCutsStore.ts` and `sectionBoxSlice.ts`). The plane-set actions go in a new `sectionPlaneSetSlice.ts` beside them, composed the way `createSectionBoxSlice` is, and the budgets are not raised.
- **Reference-tool fidelity.** The issue is a feature list plus one screenshot. Where it is silent (undo for Clear all, naming rule, the keyboard) this spec chose and says so.

## Open questions

These are decisions the issue text does not make. The spec states a default for each so work is not blocked.

1. **"A plane based on a selected object".** Default: a plane at the selection bounds face nearest the camera. Alternatives: a plane through the selection's centre, or a *pair* of planes bracketing the selection (the "isolate this storey" case, which today is the section box's "Fit to selection"). A pair is probably what "define a floor, zone, wing" wants and costs two planes of the eight.
2. **"Section" mode.** Default: the existing 2D drawing of the active plane. If the reference tool's "Section" is a 3D view that shows the kept side without a cap, say so on the issue.
3. **Persistence across sessions.** Default: sets live for the session and travel through BCF. Saving them in the browser (keyed by model identity) is straightforward, but model-relative geometry goes stale against a different file (`savedSectionCutsStore` already accepts that); say if a project file or `localStorage` is wanted.
4. **Units.** Default: the project length unit, metre fallback. If a fixed metre display is preferred, D5 shrinks to a label.

## As built

Decisions the implementation changed, with the reason. The text above is the proposal; this is the record.

- **D3, ABI.** The extra planes are **appended to the per-mesh uniform** (`MESH_UNIFORM_FLOATS` 96 → 128; `MESH_UNIFORM_OFFSET.extraClip = 96`), not placed in a new frame-level bind group. Every per-mesh packer already goes through `packRteFragmentSpace`, so one edit serves them, the legacy 96-float block is byte-identical, and the extra cost is 128 bytes per uniform write only where a batch owns a uniform. The passes that own their own uniform got the same 128-byte block: the shadow clip uniform, the point-cloud uniform, the point picker, and for the flat and instanced GPU pickers a small shared uniform (`binding(2)` / `binding(1)`) written once per pick pass, because the flat picker's 256-byte dynamic slot is full. One WGSL struct (`ExtraClip`) and one test (`extraClipClipped`) are shared by all of them.
- **Resolution is renderer-side.** `RenderOptions.extraSectionPlanes` takes the same `SectionPlane` shape as `sectionPlane`, and `resolveSectionPlaneGeometry` (`section-plane-resolve.ts`, extracted from `resolveSectionPlaneFrame`) resolves the primary and every extra plane by the same code: a cardinal plane's slider range against the renderer's own bounds, the building rotation, and the explicit-normal finiteness guards. This replaces the proposal's viewer-side distance conversion, which would have needed a second copy of the rotation and bounds logic.
- **WGSL.** `meta` is a reserved WGSL keyword (it failed to compile on a real GPU; the unit tests cannot see that), so the block's header is `planeInfo`. `extra-clip-planes.test.ts` pins the name.
- **The set.** `sectionPlane` stays the active plane and `inactiveSectionPlanes` holds the rest, as proposed. A fresh viewer holds an **unnamed placeholder**: "has a name" is "the user has a plane", and every writer that makes a cut names it (`FIRST_SECTION_PLANE_NAME`). A disabled-but-named plane is still a plane, so Cut off does not make the controls vanish.
- **Boxes.** One clip-box slot exists in the renderer, so the active plane's box wins it and an inactive boxed plane clips by its box only while the active plane has none.
- **A3 was done in L1.** The last-used-mode persistence (`sectionLastMode.ts` and the Section panel's restore-on-open effect) is deleted rather than kept: opening the tool changes nothing, and with no plane the bar offers the four ways to add one.
- **Externally supplied cuts replace the set.** `showSectionCut` (BCF viewpoint, SDK `setSection`) and `clearSectionCut` act on the whole set: such a cut is THE cut, and a plane the user added must not keep clipping beside it. Multi-plane BCF and the SDK's `getSections` are in "Layers 2–4" below.

Evidence for the renderer layer: [four planes clipping `AC20-FZK-Haus.ifc` on a real GPU](./evidence/section-7545/renderer-four-planes-real-gpu.png) (Chrome 155, NVIDIA, WebGPU; planes A front 40 % flipped, B down 60 %, C side 55 %, D front 40 % flipped). The model is cut by every plane at once: the roof and upper walls are gone (B), the left wing is gone (C), and the front is cut away (A, D). Only the active plane's cap is drawn at this layer; caps for every plane arrive with L3.

**Pixel-and-pick witness** (`tests/e2e/section-extra-planes.gpu.ts`, run by `section-extra-planes.e2e.spec.ts`): the production `Renderer` draws a flat mesh, an instanced mesh and a point cloud through one plane set that goes 0 → 7 extras → 2 → 0 → 7 → 8 (one beyond capacity, which must change nothing). At every sample point (a grid, skipping the 0.5 m around an effective plane) three independent answers are compared with the analytical "kept where every enabled plane keeps it": the colour in a Renderer-produced screenshot, the GPU ID-buffer pick, and the CPU raycaster (flat and instanced). On a real GPU (Chrome 155, NVIDIA Blackwell, WebGPU): 18 state rows, 0 mismatches, 0 GPU errors, and every row has both kept and removed samples; with the oracle deliberately wrong (capacity 1) the same run reports 21 mismatches per mesh family and 5 for points, so it cannot pass vacuously.

### Layers 2–4

What the later layers built, and where they departed from the proposal.

- **Caps (L3).** The active plane's cap still comes out of the Drawing hook. Every other *enabled* plane is cut by `useExtraSectionCaps` with the plain cutter (no projection, no hidden lines) from the same visible meshes (`visibleCutMeshes`: class visibility, hidden, isolation, storey selection), one cut at a time through the drawing request queue, and parked in `sectionExtraCaps`. A cap is keyed by the plane's geometry and the model state it was cut from; `useRenderUpdates` uploads it under the plane's id only while it still matches, so a drag that outruns the cutter leaves the previous cap on its own plane instead of lifting it onto the new one. The proposal's worker-side `cutMeshesStreaming` and 120 ms debounce were not needed for correctness and are not built; the perf A/B of the plan (main against branch, 0/1/4/8 planes, AC20 and a 29 MB fixture, real GPU, interleaved) is recorded in `scripts/perf/README.md`: draws per frame are identical to main at 0 and 1 plane, each extra plane adds about three draws, and every cap is ready in under 0.2 s (AC20) or 0.7 s (heavy fixture, 8 planes).
- **PDF export (L3).** The sheet is cut by every cutting plane (`clipMeshesBySections`), each plane's rim is trimmed by the planes applied after it, and the page estimate quotes the same intersection.
- **Controls (L2).** Offset in the project unit from the plane's datum, the step menu (1 cm to 1 m or a custom millimetre value, kept in `localStorage`), wheel stepping, Set view with memory, Show, one-switch Fill, in-scene tags and kept-side arrows, and three bar tiers measured offscreen.
- **Zoom (L4).** `CameraCallbacks.frameBounds(min, max, { padding, durationMs })` over `Camera.frameBounds`'s padding multiple; a margin is `1 + 2 * margin / extent`. The cut area is the model's bounds with its faces clipped by every cutting plane. Orthographic is exact (cut area at 1.0000 of the frame at margin 0 and 0.8333 at 10 %, measured on the real viewer); perspective is within about 3 % because nearer corners project larger. **Not built:** double-click-a-tag zoom. The tags are `pointer-events: none` so they can never intercept a pick, and the popover covers the need.
- **Saved sets (L4).** `SavedSectionCut` holds `planes` (every plane that was cutting, with its name, geometry, cap style and a box when it was one), `activeIndex`, `zoom` and the exact `viewpoint`. Applying replaces the whole set through `installSectionPlanes`, un-hides it, opens the tool, then restores the camera, or frames the saved zoom when none was saved. Planes that were only previewing are not part of a saved cut (the proposal's "no enabled/parked" intent, made explicit). The **Views** menu on the bar and the Drawing panel's header menu show the same list. The list lives in memory for the session, as proposed; cross-session persistence stays an open question.
- **Basket views and scene actions (L4).** A basket snapshot keeps every cutting plane in creation order and which one was active, and a basket view with no cut now turns *every* plane off (the old code switched off only the active plane). A scene-action restore puts back the whole set and reports `changed`, keeping the user's work, when a plane was added since.
- **BCF (L4).** `createViewpoint({ sectionPlanes })` writes one `ClippingPlanes` entry per enabled plane, in order; `extractViewpointState` returns `sectionPlanes` (and `sectionPlane` = the first). The viewer captures the active plane first and applies a viewpoint as a replacement of the whole set, the first plane active; names are regenerated A, B, C, and more than eight planes show the first eight with a notice. The BCF panel's close-restore hands back the whole set.
- **SDK (L4).** `bim.viewer.getSections/setSections/addSection/removeSection(id)` and `bim.bcf` `sectionPlanes`. The new `ViewerBackendMethods` entries are optional with single-plane fallbacks, so the MCP and streaming-viewer backends are untouched. The sandbox `bim` script bridge exposes no section method, so there is no `bim-globals` change; the API-surface snapshot (top-level exports) is unchanged.
- **Review fixes.** Independent source reviews of the whole stack found, and the stack now fixes, with tests that fail on the old source:
  - a boxed inactive plane made `sectionRenderClip` drop the active plane's own cut (so the cut changed with the selected plane); an active box that was switched off held the one box slot against a box that was cutting; and a box was exported (PDF, BCF, SDK) and zoomed to as the axis and position it carried from before it was a box. A box now clips by its six faces everywhere and is left out of BCF and `getSections`;
  - arrow keys on the plane chips left focus on the old chip; the alignment picker stayed open on the plane chosen next; an armed "add a plane" pick stripped the active plane's alignment and, left over, turned a later face cut into an added plane;
  - choosing another plane drew the previous plane's cap on it until the new drawing arrived; an extra plane's cap that built no geometry still held one of the seven cap slots;
  - Undo after Remove reverted everything edited since; it now gives back only the removed planes, merged into the set as it is;
  - BCF capture from a 2D section moved every other plane to the model's midpoint on the other axes; saving a view with no plane stored a placeholder that cut when applied; the cut area was not the true extent for planes meeting inside the model (it now enumerates the vertices of the kept polyhedron); a typed `-200 mm` was committed as -200 m (typed numbers are now parsed strictly);
  - `packExtraClip` built a typed-array view per call, per mesh, per frame.
- **Known limits, kept.** Perspective margins scale the stand-off distance, so they are exact in orthographic and approximate (about 3 % at small margins, growing with field of view and margin) in perspective. The `[` / `]` and Alt+wheel shortcuts of the plan were not built. Inactive planes resolve against the renderer's own bounds while the active plane uses the Section range, the same for ordinary models. The cardinal drag handle assumes an unrotated building.


# @ifc-lite/embed-sdk

## 1.15.0

### Minor Changes

- [#3682](https://github.com/LTplus-AG/ifc-lite/pull/3682) [`243a95a`](https://github.com/LTplus-AG/ifc-lite/commit/243a95a09fac2493d551c33cac39b0c79fc9b8bf) Thanks [@louistrue](https://github.com/louistrue)! - `SET_TYPE_VISIBILITY` reaches all seven type-visibility toggles, not three of them.
  
  The viewer store has seven type-visibility controls; the embed protocol declared three (`spaces`, `openings`, `site`). The protocol was written when the store had three, and nothing tied the two sets together, so `spatialZones`, `virtualElements`, `ifcAnnotations` and `ifcGrid` were added to the store and silently never reached a host. A host that sent one got an OK response and no effect.
  
  `@ifc-lite/embed-protocol` gains `TYPE_VISIBILITY_FLAG_KEYS` (a runtime list of all seven, in store order) and `TypeVisibilityFlags` (the payload type built from it, with a doc comment naming the IFC classes each flag gates). `SET_TYPE_VISIBILITY`'s payload is now that type, and `setTypeVisibility` in `@ifc-lite/embed-sdk` takes it instead of its own inline three-field copy. Both are additive: an existing three-field call still compiles and still means the same thing.
  
  Two smaller fixes ride along in the embed viewer. The command handler loops `TYPE_VISIBILITY_FLAG_KEYS` instead of naming three flags by hand, keeping the same "only toggle a flag that actually differs" rule. And the embed's mesh filter now calls `isTypeVisible` from the store's `typeVisibilityFilter`, the file that calls itself the single source of truth for the class-to-toggle mapping, instead of a private copy that named three of the seven mapped classes: `IfcSpatialZone`, `IfcVirtualElement`, `IfcGeographicElement` and 3D `IfcAnnotation` solids now follow their toggles in the embed the way they already did in the full viewer.
  
  `PROTOCOL_VERSION` stays `'1.0'`, and neither side ever compares it, so nothing breaks on a mismatch. But do not read that as safe. A new SDK against an older viewer, which the `origin` option makes a supported deployment, gets a resolved promise and no effect for the four new flags: the same silent no-op this release exists to remove, moved to version skew. `READY` still reports `'1.0'`, so a host cannot feature-detect either. Publish the embed before the SDK. Making the skew detectable needs a version bump, which changes the literal type of every envelope, so it is a separate decision.
  
  The bridge test now pins the protocol list against the store's `TypeVisibility` at runtime (same key set) and at compile time (every protocol key is a store key, and no store key is missing), so the two cannot drift apart again.
  
  Two behaviour notes for existing embeds, because both are visible and neither produces an error.
  
  `IfcSpatialZone` and `IfcVirtualElement` had no gate at all in the embed's private mapping, so they rendered whatever the toggles said. They now follow `spatialZones` and `virtualElements`, which default to off (`IfcVirtualElement` off since [#1133](https://github.com/LTplus-AG/ifc-lite/issues/1133), because non-physical clearance volumes obscure real geometry). An embed that never sends `SET_TYPE_VISIBILITY` and was showing gross-area zones or clearance volumes will stop showing them. That is the fix doing its job, and it matches the full viewer, but it is a change you did not ask for. To keep the old rendering, send `setTypeVisibility({ spatialZones: true, virtualElements: true })`.
  
  `site` changed meaning too, and it is the one flag that already existed, so this reaches hosts using today's API. It gated `IfcSite` alone; through the shared mapping it now also gates `IfcGeographicElement`, the modelled terrain that [#1480](https://github.com/LTplus-AG/ifc-lite/issues/1480) paired with it. A dashboard sending `site: false` to drop the site plate now loses terrain with it.
  
  Defaults are also not a stable starting point. The embed shares the viewer's store, whose initial toggle state comes from `localStorage` on the embed's own origin, and every `SET_TYPE_VISIBILITY` persists back to it. So a returning visitor can start from their last session rather than from the defaults, and because every embed is served from one origin, that state is not scoped per host. This is how the three previous flags already worked; there are now seven of them. A host that needs a deterministic starting state should send `setTypeVisibility(...)` on every load rather than relying on defaults.
  
  Not fixed here, and adjacent enough to name: the embed still re-multiplies `IfcSpace` and `IfcOpeningElement` alpha down to 0.3 in the same filter chain, which `ViewportContainer` dropped under [#677](https://github.com/LTplus-AG/ifc-lite/issues/677) because it stomped explicit colour choices. The clamp lives in a React memo, so it bites whenever geometry is uploaded from that mesh list: the initial load, a model swap, colours that arrive while streaming is still running, and any type-visibility toggle, which re-uploads the visible set. The sequence that reproduces it is colour a space, then turn spaces on, and the space comes back at 0.3. A colour sent after load is not affected, because `SET_COLORS` also queues `pendingMeshColorUpdates` and that reaches `scene.updateMeshColors` directly while the geometry effect early-returns on an unchanged mesh count. It predates this change and needs its own diff.

### Patch Changes

- [#3367](https://github.com/LTplus-AG/ifc-lite/pull/3367) [`37ce0d0`](https://github.com/LTplus-AG/ifc-lite/commit/37ce0d0ab9587b8bb1098dc05cc4e3a44c6f4741) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Implement the embed viewer's `?controls=` param / `EmbedOptions.controls` ([#2934](https://github.com/LTplus-AG/ifc-lite/issues/2934)). It was parsed since the embed shipped and never applied — there was no gate anywhere in the camera controller to restrict orbit, pan, or zoom against.
  
  `@ifc-lite/renderer`'s `Camera` gains `setInteractionMode('orbit' | 'pan' | 'all' | 'none')`, implemented at the single choke point every gesture already shares (`CameraControls.orbit`/`.pan`/`.zoom`), so mouse, touch, keyboard, and spacemouse input are all restricted together: `'orbit'` allows only orbit, `'pan'` only pan, `'none'` freezes the view (orbit, pan and zoom), `'all'` is unrestricted (the default, unchanged for every existing consumer). Programmatic moves — `setCameraRotation`, `setPresetView`, `zoomExtent`, `frameBounds`, and therefore the embed's `SET_CAMERA` command and `?camera=`/`?view=` params — are untouched by any mode. That includes the SpaceMouse fit buttons, which call `frameBounds`/`zoomExtent` directly and so still reframe the view under `controls=none`.
  
  `@ifc-lite/embed-protocol` and `@ifc-lite/embed-sdk` had their `controls` (and, leftover from the earlier [#2934](https://github.com/LTplus-AG/ifc-lite/issues/2934) fixes, `hideAxis`/`hideScale`) doc comments corrected from "NOT YET IMPLEMENTED" to describe the real behaviour — no type changes.

- [#3719](https://github.com/LTplus-AG/ifc-lite/pull/3719) [`4f670aa`](https://github.com/LTplus-AG/ifc-lite/commit/4f670aa0d8e544b5fbe0cd26db34f4fb3974938a) Thanks [@louistrue](https://github.com/louistrue)! - Let `hideTypes` reach the symbolic 2D overlay, so `hideTypes: ['IfcAnnotation']` stops being a silent no-op.
  
  `IfcAnnotation` 2D content is not a mesh. Rust routes every shape representation identified `Plan`, `Annotation`, `FootPrint` or `Axis` into symbolic data (`rust/processing/src/symbolic/mod.rs`), which the viewport draws as a line-and-text overlay gated only on the store's `typeVisibility.ifcAnnotations` and `.ifcGrid`. The embed's `hideTypes` filters the mesh list, so it could never touch that overlay: a host naming `IfcAnnotation` got silence and no error ([#2934](https://github.com/LTplus-AG/ifc-lite/issues/2934)). Measured on AC20-FZK-Haus through the real embed build, five states pixel-diffed against each other: before this change `hideTypes=IfcAnnotation` moved 0 of 960,000 pixels, while turning the store's own annotation toggle off moved 6,492 — the same 6,492 that stripping the 14 `IFCANNOTATION` instances out of the bytes moves. After it, the `hideTypes` states are pixel-identical to both (0 px apart), by either host route: `INIT`'s `config.hideTypes` and `?hideTypes=`.
  
  The embed now publishes its case-folded hidden-class set to `store.hostHiddenIfcTypes`, and the two overlay hooks read it there, beside the per-entity hides they already apply, through one pure function (`lib/symbolic-overlay-gate.ts`). Nothing is threaded through `Viewport`: the overlay is built two levels below it, and a prop would have added a link only `Viewport` could keep honest — and no test mounts `Viewport`, which needs a WebGPU device.
  
  **What `hideTypes` matches, for the 2D overlay.** The class that OWNS the drawn content, taken from the one table the overlay parse itself uses (`lib/overlay-parse/overlay-channels.ts`): dimensions, leaders and room tags are `IfcAnnotation`; grid axes and their bubbles are `IfcGridAxis`, not `IfcGrid`, which owns no drawn content and so hides nothing. Naming a wall or a space removes their meshes and no 2D content — their `Axis` / `FootPrint` representations are not drawn in the 3D viewport at all (they reach the 2D drawing generator, which this does not gate). Should a channel ever draw a second owner class, it switches off only when every class it draws is hidden, so hiding one class can never take another's content with it.
  
  Precedence is unchanged: `hideTypes` and the store toggles both apply, and a class named in `hideTypes` stays hidden when a later `SET_TYPE_VISIBILITY` turns its toggle on, exactly as a hidden `IfcSpace` mesh behaves today. The full viewer sets no host list and renders as before.

- [#3412](https://github.com/LTplus-AG/ifc-lite/pull/3412) [`fd08959`](https://github.com/LTplus-AG/ifc-lite/commit/fd0895915e1af62a79659a8cb52ce0bb778ca65b) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Expose `autoLoad` on `EmbedOptions`, so an SDK host can suppress the automatic model fetch.
  
  The viewer has honoured `?autoLoad=false` since the auto-load effect gained its gate, but the SDK's typed options object never carried the field. A host building the iframe URL by hand could opt out; a host using the SDK could not express it at all — the option existed on one side of the same API and not the other.
  
  `embedUrlSearchParams` now emits `autoLoad=false` when, and only when, the caller passes `false`. This is the opposite polarity to `hideAxis`/`hideScale`, which default off and are emitted when true: `autoLoad` defaults ON, so omission and `true` are the same answer and neither is serialised. The literal string matters — the viewer parses the parameter as `autoLoad !== 'false'`, so any other value (`0`, empty) reads back as true and would load the model the host asked us not to.
  
  Not included: a round-trip test binding the serialiser to the parser. `@ifc-lite/embed-sdk` and `apps/viewer-embed` do not depend on each other, so pinning the contract end to end would mean either a new dependency edge or a shared fixture in `@ifc-lite/embed-protocol` (the pattern used for the CSV and STEP escapers). Both halves are tested independently; the seam between them is not.
- Updated dependencies [[`37ce0d0`](https://github.com/LTplus-AG/ifc-lite/commit/37ce0d0ab9587b8bb1098dc05cc4e3a44c6f4741), [`243a95a`](https://github.com/LTplus-AG/ifc-lite/commit/243a95a09fac2493d551c33cac39b0c79fc9b8bf)]:
  - @ifc-lite/embed-protocol@1.15.0

## 1.14.11

### Patch Changes

- [#3189](https://github.com/LTplus-AG/ifc-lite/pull/3189) [`ca32e75`](https://github.com/LTplus-AG/ifc-lite/commit/ca32e75e85fd84127a08e9204b3db52b1b3efcc0) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Embed URL parameters: document which are applied and which are still inert.
  
  `?select=`, `?isolate=`, `?hideTypes=` and `?camera=` are now applied by the
  embed viewer (they were parsed and never read). `EmbedUrlParams` and the SDK's
  `EmbedOptions` now say so per field, and mark `controls`, `hideAxis` and
  `hideScale` as parsed-but-not-implemented instead of leaving them looking
  wired. `hideTypes` matches IFC class names case-insensitively, so the
  SCREAMING_CASE spelling the SDK documents by example resolves the same as
  PascalCase.
  
  `select` and `isolate` now ignore empty or non-positive id segments (e.g. a
  bare `?isolate=,`) instead of treating them as express id `0`, which used to
  isolate nothing and blank the whole model with no error.
  
  `?camera=` now requires every segment to be finite: `Number('Infinity')` is not
  `NaN`, so `?camera=Infinity,0` used to clear the numeric filter and steer the
  view to a non-finite azimuth instead of falling back to home framing.
  
  `EmbedOptions` now carries `select` and `isolate`, serialised as comma-separated
  query parameters. Both were already in `EmbedUrlParams` and applied by the
  viewer, so an initial selection was previously reachable only by hand-writing
  the iframe URL.
- Updated dependencies [[`ca32e75`](https://github.com/LTplus-AG/ifc-lite/commit/ca32e75e85fd84127a08e9204b3db52b1b3efcc0)]:
  - @ifc-lite/embed-protocol@1.14.9

## 1.14.10

### Patch Changes

- [#2978](https://github.com/LTplus-AG/ifc-lite/pull/2978) [`f64ecdc`](https://github.com/LTplus-AG/ifc-lite/commit/f64ecdc2129074d2d3def676d6ddd69dffdd785e) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Three embed API commands that reported success while doing nothing now work
  ([#2934](https://github.com/LTplus-AG/ifc-lite/issues/2934)). Each was broken at a different link in the chain.
  
  `SET_CAMERA` had no actuator. The handler called the store's
  `setCameraRotation`, which was `set({ cameraRotation })` and nothing more —
  every orientation entry point on the camera was either relative (`orbit`, the
  90° rotate steppers) or named a direction (`setPresetView`), so an absolute
  azimuth/elevation pair had nothing to reach. The host got a `requestId` ack
  *and* a `CAMERA_CHANGED` echo of its own numbers back, while the view never
  moved. `Camera.setRotation(azimuth, elevation)` is new on `@ifc-lite/renderer`
  — the exact inverse of `Camera.getRotation`, absolute and idempotent, keeping
  the target and orbit distance, with the same pole clamp `orbit` uses — and the
  store action now drives it the way `setProjectionMode` drives its own callback.
  
  `RESET_COLORS` cleared the wrong channel, in both directions at once.
  `SET_COLORS` bakes into the mesh colors, while `clearPendingColorUpdates`
  empties the transient overlay channel the lens, IDS, clash and schedule
  overlays own: the host's own override survived the reset, and another
  subsystem's state was destroyed by it. `SET_COLORS` now marks its writes as an
  override, which captures the colors it displaces, and `RESET_COLORS` restores
  those and leaves the overlay channel alone. The loader's own IFC style pass is
  deliberately not treated as an override, so a reset restores the model's IFC
  colors rather than stripping them.
  
  For integrators, that second half is a behaviour change on a published surface
  and not only a fix: `RESET_COLORS` no longer clears `pendingColorUpdates`. A
  host that had been sending it to clear a lens, IDS, clash or schedule overlay
  was relying on a side effect that is now gone, and must clear that overlay
  through the command that owns it. `RESET_COLORS` only undoes `SET_COLORS`.
  
  Also worth knowing before you rely on it: `RESET_COLORS` restores the entities
  the viewer holds in its primary `geometryResult`, which is the FIRST loaded
  model. In a federated embed with more than one model, `SET_COLORS` still
  colours entities in the later models and `RESET_COLORS` does not restore them,
  while both commands ack success. Single-model embeds — the common case — are
  unaffected.
  
  `ENTITY_HOVERED` was declared, exposed by the SDK, and never emitted — the SDK
  tests passed because they fabricated the event themselves. The viewer's hover
  pipeline was already there but gated behind a toolbar toggle the embed has no
  chrome to offer; the embed now enables it and emits on each hover-target
  change.
  
  `SET_CAMERA`'s `zoom` field remains unapplied and is now documented as
  reserved rather than silently dropped: it has no defined meaning on the viewer
  side, and guessing one is worse than saying so.
  
  **RESET_COLORS restored the previous model's colours onto the current one.** `meshColorBackup` holds each element's ORIGINAL colour so the reset can put it back, and it was cleared in exactly one place, `resetMeshColors` itself, and in no teardown path. Its keys are global express ids and those are reused across a model swap, so a backup that outlived its model did not go inert: it named live elements of the next one, and `resetMeshColors` queued the departed model's colours into `pendingMeshColorUpdates` for the renderer to upload.
  
  Reproduced against the real store before fixing: load A with entity 12 red, override it, `resetViewerState()`, load B with entity 12 blue, reset. Entity 12 came back A's red.
  
  The map is also first-write-wins, so one leaked entry was permanent. A later override on the new model declined to record that element's real colour, because the id was already present, and every reset from then on restored the wrong one. It corrupted the feature for the rest of the session rather than for one reset.
  
  Cleared now in `resetViewerState`, `removeModel` and `clearAllModels`, and the three are not the same clear.
  
  `resetViewerState` and `clearAllModels` drop the map whole, because both restart the id space: `clearAllModels` calls `federationRegistry.clear()`, offsets go back to 0, and the next model genuinely is handed the ids the last one used.
  
  `removeModel` purges only the removed model's entries, via `resolveGlobalIdInModel`, the owner-scoped resolver this slice already provides for exactly this question. Dropping the map whole there would take the SURVIVING models' undo with it, and it is not needed for them: `unregisterModel` BURNS the removed range rather than reclaiming it, so no later model can be handed those ids. An earlier draft of this fix did drop it whole, and the effect was worse than the bug in one respect: with a live override on a model that was not the one removed, `resetMeshColors` then had nothing to restore from, leaving the store and the GPU out of step with no action left to reconcile them.
  
  **Module-size budgets, recorded deliberately and with the reason.** The gate that landed in [#3045](https://github.com/LTplus-AG/ifc-lite/issues/3045) requires either a split or a written justification for a raise, so here is the justification.
  
  Seven files are raised and one row is added. Two of the raises are this fix's own lines, four in `store/index.ts` and thirteen in `store/slices/modelSlice.ts`; the other five and the new row are this PR's feature growth (`camera.ts` +71, `dataSlice.ts` +81, `EmbedViewer.tsx` +39, `types.ts` +12, `Viewport.tsx` +9, `handler.ts` +7).
  
  Splitting was considered and rejected for `dataSlice.ts`, which is the one that matters: it crosses 400 for the first time, at 471. It is a Zustand `StateCreator` returning a single object literal, so dividing it is a restructure of the slice's shape rather than a file move, and doing that inside a bug-fix PR trades a contained change for a broad one. **That is debt, not a resolution**, and it should be split on its own.
  
  One hazard worth naming for whoever resolves the next conflict here: `--update` re-records EVERY row that changed, not only the ones a PR touches. It silently pulled two rows for `packages/cli` and `packages/mcp` into this diff, packages this change never opens. Both are restored and the pin recomputed by hand, so the allowlist diff names only files this PR actually grows.
  
  Worth stating for whoever tunes this gate next: **312 of its 314 rows sit at exactly their measured size on main.** A one-line fix to any of them trips it. This PR's two-line teardown fix did, and every future fix to an allowlisted file will arrive needing a split or a raise.
  
  
  **One thing left standing, deliberately.** `pendingMeshRemovals`, `pendingMeshTranslations` and `pendingMeshRotations` are id-keyed exactly like `meshColorBackup` and are cleared in no teardown path either. `pendingMeshRemovals` is worse than the others, because it ACCUMULATES (`new Set(state.pendingMeshRemovals ?? [])`) rather than being overwritten, so a survivor merges into the next model's removals. `clearAllModels` also clears the backup but not `pendingMeshColorUpdates`, on the one path where offsets really do restart. All of that is pre-existing and none of it is what this PR broke, so it is named here rather than folded in.
  
  **A fourth path leaked the backup, and it is the one an embed host hits.** The three teardown clears above do not cover `setGeometryResult` REPLACING geometry, and `useIfcFederation` calls exactly that on an ACTIVE-MODEL SWITCH: no reset, no removal. So switching models left the backup pointing at the model you came from. Reproduced, then fixed by clearing when the geometry's identity changes; a redundant set of the same object keeps a live undo, which is the mistake the `removeModel` clear made in its first draft.
  
  That one was found by review on 2026-08-22, before this round started, and it is worth saying plainly that the three clears alone would have shipped looking complete.
  
  **`SET_CAMERA` acked before the renderer existed.** `setCameraRotation` calls the actuator optionally and then records the pose, and `setCameraCallbacks` only stored the callbacks. An embed host sending SET_CAMERA before `Viewport`'s effect registers gets a success ack and a camera that never moves: success reported for something that did not happen. A rotation accepted with no actuator is now held and replayed on registration, and an already-applied one is not replayed, so registering a second renderer cannot re-fire it.
  
  **`Camera.setRotation` propagated a non-finite TARGET.** The existing guard rejects non-finite ANGLES, and `isUsableDistance` rescues the radius, but every position component is `target.<axis> + ...` and `setTarget` accepts non-finite coordinates. One NaN there made the whole pose NaN, in a method whose contract is that it RECOVERS a pose. It now refuses, the same way it refuses non-finite angles.
  
  **Two review findings are deferred rather than fixed, with reasons.** `dataSlice.test.ts` carries 19 `as any` casts on its mesh fixtures; typing the fixture properly is the right fix and is test-hygiene work on this PR's own suite rather than anything the fixes above touch. And the `ENTITY_HOVERED` tests cover only model-free ids, so the single-model and N-model federation cases are genuinely uncovered. Both are real; neither is a correctness defect, and folding either in would grow a change that has already grown three times.
- Updated dependencies [[`f64ecdc`](https://github.com/LTplus-AG/ifc-lite/commit/f64ecdc2129074d2d3def676d6ddd69dffdd785e)]:
  - @ifc-lite/embed-protocol@1.14.8

## 1.14.9

### Patch Changes

- [#1691](https://github.com/LTplus-AG/ifc-lite/pull/1691) [`26af236`](https://github.com/LTplus-AG/ifc-lite/commit/26af236a9128f5fc97493d75d7c9642958343a7a) Thanks [@louistrue](https://github.com/louistrue)! - Documentation moved to https://ifclite.dev/docs/ - README links and package homepage fields now point at the new home (the GitHub Pages site remains as a mirror whose canonical URLs point there).

- Updated dependencies [[`26af236`](https://github.com/LTplus-AG/ifc-lite/commit/26af236a9128f5fc97493d75d7c9642958343a7a)]:
  - @ifc-lite/embed-protocol@1.14.7

## 1.14.8

### Patch Changes

- [#1676](https://github.com/LTplus-AG/ifc-lite/pull/1676) [`da04601`](https://github.com/LTplus-AG/ifc-lite/commit/da0460183dcb4e2b26ceb53cfebd8cca33c78c39) Thanks [@louistrue](https://github.com/louistrue)! - Docs refresh: correct stale README claims and API samples against the current codebase; add READMEs to the ten published packages that shipped without one (cli, create, sdk, sandbox, lens, lists, embed-sdk, embed-protocol, encoding, viewer-core).

- [#1678](https://github.com/LTplus-AG/ifc-lite/pull/1678) [`a90182b`](https://github.com/LTplus-AG/ifc-lite/commit/a90182bac110fdd4c15b8b51866e31deefc0378e) Thanks [@louistrue](https://github.com/louistrue)! - Package metadata hygiene: correct the @ifc-lite/codegen license field to MPL-2.0 (the source has always carried MPL headers; the MIT value was a scaffolding accident) and give it a files allowlist so the npm tarball ships dist, schemas, and README instead of the whole package directory. Add the missing publishConfig, homepage, and bugs fields to codegen, embed-protocol, embed-sdk, and wasm, and homepage/bugs to create-ifc-lite, matching the rest of the workspace.

- Updated dependencies [[`da04601`](https://github.com/LTplus-AG/ifc-lite/commit/da0460183dcb4e2b26ceb53cfebd8cca33c78c39), [`a90182b`](https://github.com/LTplus-AG/ifc-lite/commit/a90182bac110fdd4c15b8b51866e31deefc0378e)]:
  - @ifc-lite/embed-protocol@1.14.6

## 1.14.7

### Patch Changes

- [#1087](https://github.com/LTplus-AG/ifc-lite/pull/1087) [`0d1703b`](https://github.com/LTplus-AG/ifc-lite/commit/0d1703bdd4eaf5584cef177652e5ae9e8656e459) Thanks [@louistrue](https://github.com/louistrue)! - Fix the default embed viewer origin: `embed.ifc-lite.com` does not exist (NXDOMAIN), the hosted viewer lives at `embed.ifclite.com`. Without an explicit `origin` option, `IFCLiteEmbed.create()` pointed the iframe at a dead domain and rejected with a handshake timeout after 15s. Existing SDK versions can work around this by passing `origin: 'https://embed.ifclite.com'`.

## 1.14.6

### Patch Changes

- [#1036](https://github.com/LTplus-AG/ifc-lite/pull/1036) [`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc) Thanks [@louistrue](https://github.com/louistrue)! - Add a `default` condition to every package's exports map. The maps only
  declared `import` + `types`, so any resolver hitting the CJS/default
  condition path (tsx, jest, plain `require`, some bundlers) failed with
  ERR_PACKAGE_PATH_NOT_EXPORTED. The `default` entry points at the same
  ESM dist file; pure ESM consumers are unaffected.
- Updated dependencies [[`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc)]:
  - @ifc-lite/embed-protocol@1.14.5

## 1.14.5

### Patch Changes

- [#946](https://github.com/LTplus-AG/ifc-lite/pull/946) [`6378998`](https://github.com/LTplus-AG/ifc-lite/commit/6378998ec146f7f9297ef5fcc5953b155fd6b5e0) Thanks [@louistrue](https://github.com/louistrue)! - Fix a batch of verified findings from a full-codebase review (security, correctness,
  data-loss, and resource/memory leaks). Highlights:

  **Security**

  - collab-server: a malformed WebSocket frame no longer crashes the whole process
    (decode is wrapped; a bad frame is rejected/audited instead of throwing).
  - mcp: the local HTTP transport now validates `Host`/`Origin` and no longer sends a
    wildcard `Access-Control-Allow-Origin`, closing a DNS-rebinding/CSRF hole; the
    `AuthScope.modelIds` allowlist is now enforced at model resolution.
  - server-bin: `extractZip` uses `execFileSync` (argv, no shell), removing command
    injection via archive/destination paths.
  - export / sdk / cli / mcp / lists / viewer CSV exporters now neutralize spreadsheet
    formula injection (CWE-1236) consistently.
  - create-ifc-lite: validates the project name (no path traversal) and drops the
    unused `execSync`-based downloader.
  - embed-sdk: inbound `postMessage` now validates `event.origin`.

  **Correctness / data-loss**

  - parser: `lengthUnitScale` survives the worker transport; the nested STEP list
    parser is string-aware (commas/parens inside quoted values no longer mis-split).
  - mutations: deleting a property from a session-created pset and replaying
    `UPDATE_ATTRIBUTE` / `CREATE_PROPERTY_SET` mutations now work.
  - export: merged-export ID remapping no longer rewrites `#N` inside quoted strings.
  - drawing-2d: GPU section cutter triangle upload/readback use correct WGSL std-layout
    offsets and strides.
  - ifcx: cyclic children no longer abort the parse; spatial children round-trip; the
    mesh transform guards a zero/non-finite homogeneous `w`.
  - data / cache: a `NULL` string property value stays `null` instead of becoming `""`.
  - pointcloud, bcf, server-client, query, viewer-core, viewer store/federation: assorted
    decoding, federation-id, and selection-state fixes.

  **Resource / memory leaks**

  - geometry, query (DuckDB), renderer (GPU buffers), collab (federation presence),
    sandbox (host log capture + runtime), mcp (clash mesh cache), server-bin (signal
    listeners), and the viewer renderer on unmount now release resources deterministically.

  **Hardening (apps, not published)**

  - server: a dedicated `server-release` Cargo profile (`panic = "unwind"`) plus a
    `CatchPanicLayer` contain a malformed-IFC parse panic to the offending request
    instead of aborting the whole server.
  - desktop (Tauri): a Content-Security-Policy is set, and unused `shell:*` /
    `fs:allow-write|mkdir|remove` capabilities (and the unused shell plugin) are removed.

  **Second pass** (additional verified findings)

  - collab-server: S3 log load now follows `ListObjectsV2` pagination (no dropped frames);
    awareness frames are size-capped + rate-limited; path-lock verify runs after role/rate-limit;
    the blob route requires auth and `/metrics` can be token-gated.
  - server-bin: downloaded binaries are SHA-256 verified against a release sidecar (fail-closed on
    mismatch, warn-if-absent for older releases).
  - extensions: inner-ring capability check fails _closed_ for unknown namespaces; signing
    canonicalization is now injective (length-prefixed).
  - correctness/leaks: mutations quantity type+unit preserved on replay; `findByProperty` boolean
    comparisons; Parquet REAL columns kept as Float64; blob GC fail-safe on missing `uploadedAt`;
    spatial-hierarchy + codegen cycle guards; BVH NaN edge; bSDD/playground caches bounded;
    point-cloud GPU asset freed on federation error; mcp `parseColor` rejects non-hex; bcf/SVG/STEP
    output escaping; and more.

## 1.14.4

### Patch Changes

- [#760](https://github.com/LTplus-AG/ifc-lite/pull/760) [`1282b13`](https://github.com/LTplus-AG/ifc-lite/commit/1282b13fbaf8db90197ebd3d272f59d3031810ed) Thanks [@louistrue](https://github.com/louistrue)! - Ship compiled JavaScript instead of raw TypeScript source.

  Both packages previously published with `main`/`types`/`exports` pointing at
  `./src/index.ts` and no build step, so the tarball contained only
  `src/index.ts`. A plain `npm install` + `import` failed with
  `Unknown file extension ".ts"` in Node, and the packages were fragile under
  `tsc`, Jest, ts-node, and non-esbuild bundlers — despite `@ifc-lite/embed-sdk`
  being intended for external embedding (Power BI, Superset, Grafana).

  They now build with `tsc` to `dist/` and export `./dist/index.js` +
  `./dist/index.d.ts`, matching every other publishable package in the repo.

- Updated dependencies [[`1282b13`](https://github.com/LTplus-AG/ifc-lite/commit/1282b13fbaf8db90197ebd3d272f59d3031810ed)]:
  - @ifc-lite/embed-protocol@1.14.4

## 1.14.3

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/embed-protocol@1.14.3

## 1.14.2

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/embed-protocol@1.14.2

## 1.14.1

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/embed-protocol@1.14.1

## 1.14.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/embed-protocol@1.14.0

## 1.13.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/embed-protocol@1.13.0

## 1.12.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/embed-protocol@1.12.0

## 1.11.3

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/embed-protocol@1.11.3

## 1.11.1

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/embed-protocol@1.11.1

## 1.11.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/embed-protocol@1.11.0

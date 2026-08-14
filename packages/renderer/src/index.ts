/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @ifc-lite/renderer - WebGPU renderer
 */

export { WebGPUDevice } from './device.js';
export { RenderPipeline } from './pipeline.js';
export { Camera } from './camera.js';
export type { ProjectionMode } from './camera-state.js';
export { pickFitPolicy } from './camera-fit-policy.js';
export type { FitPolicy, FitPolicyKind, Bounds3, PickFitPolicyOptions } from './camera-fit-policy.js';
export { Scene } from './scene.js';
export { Picker } from './picker.js';
export { MathUtils } from './math.js';
// The orthonormal camera basis `MathUtils.lookAt` renders through, exposed so
// that a consumer which has to reconstruct the on-screen frame outside the
// renderer derives it from the same substitution the picture used, instead of
// recomputing `cross(forward, up)` and inventing its own answer for a
// degenerate `up` (#2467 made this call inside the package; the Cesium overlay
// is the same situation from outside it).
export { viewBasis } from './math.js';
export { SectionPlaneRenderer } from './section-plane.js';
export { Section2DOverlayRenderer } from './section-2d-overlay.js';

// IfcAnnotation overlay pipelines (3D world-space). Self-contained — caller
// passes a GPUDevice + presentation format and invokes `.render(pass, viewProj)`
// from inside an RGBA-blended pass. See packages/renderer/src/symbolic-overlay-pipelines.ts.
export {
  SymbolicFillPipeline,
  SymbolicTextPipeline,
  type SymbolicFillInput,
  type SymbolicTextInput,
} from './symbolic-overlay-pipelines.js';
export { SymbolicTextAtlas } from './symbolic-text-atlas.js';

// Section cap styling (hatch pattern ids + default colours). The cap itself
// is now rendered by Section2DOverlayRenderer's fill pass; this module just
// holds the styling primitives shared with the store and UI.
export { DEFAULT_CAP_STYLE, HATCH_PATTERN_IDS } from './section-cap-style.js';
export type { SectionCapStyle, HatchPatternId } from './section-cap-style.js';
export { planeBasis, nearestCardinalAxis } from './section-plane-basis.js';
export type { PlaneBasis, Vec3Tuple } from './section-plane-basis.js';
export type { Section2DOverlayOptions, Section2DOverlayCapStyle, CutPolygon2D, DrawingLine2D } from './section-2d-overlay.js';
export { Raycaster } from './raycaster.js';
export { SnapDetector, SnapType } from './snap-detector.js';
export { BVH } from './bvh.js';
export { FederationRegistry, federationRegistry } from './federation-registry.js';
export type { ModelRange, GlobalIdLookup } from './federation-registry.js';
export * from './types.js';
export {
    resolveEnvironment,
    deriveSkyGradient,
    packEnvironmentUniforms,
    ENVIRONMENT_UNIFORM_SIZE,
} from './environment.js';
export type { LightingEnvironment, ResolvedEnvironment, SkyGradient, Vec3Color } from './environment.js';
export type { Ray, Vec3, Intersection } from './raycaster.js';
export type { SnapTarget, SnapOptions, EdgeLockInput, MagneticSnapResult } from './snap-detector.js';

// Extracted manager classes
export { PickingManager } from './picking-manager.js';
export type { PointPickProvider } from './picking-manager.js';
export { resolveContributionThresholdPx, projectedAabbRadiusPx } from './contribution-cull.js';
export type { ContributionCullOptions, CullCameraState } from './contribution-cull.js';
export { chunkCellKey, bucketBaseKeyFor, DEFAULT_CHUNK_CELL_SIZE } from './chunk-grid.js';
export type { SpatialChunkingConfig, ChunkAnchorSource } from './chunk-grid.js';
export { selectEvictions, MIN_EVICTION_AGE_FRAMES } from './residency.js';
export type { ResidencyShell, ColdGeometryProvider } from './residency.js';
export { simplifyIndicesByClustering, lodCellSizeForBounds, LOD_MIN_TRIANGLES, LOD_CELL_FRACTION } from './lod-simplify.js';
export { quantizeInterleaved, octEncode, octDecode, QUANT_STEP, MAX_QUANT_EXTENT, QUANT_BYTES_PER_VERTEX } from './quantize.js';
export type { QuantizedVertexData } from './quantize.js';
export { sumResidentGpuBytes } from './render-stats.js';

// The hide/isolate rule and its change detection, shared with consumers that
// render the model outside this package's pipeline (the Cesium world view,
// #2578) and so must reach the same verdict the viewport does.
export { isEntityVisible } from './entity-visibility.js';
// Alpha constants the Cesium world view must match, since it renders the model
// through its own glTF pipeline rather than this one (#2591).
export { DEFAULT_GHOST_ALPHA, OPAQUE_ALPHA_CUTOFF } from './overlay-routing.js';
export { VisibilityEpochTracker } from './visibility-epoch.js';
export type { FrameStats, ResidentGpuBytes } from './render-stats.js';
export { RaycastEngine } from './raycast-engine.js';
export type { RenderDegradationInfo } from './render-degradation.js';
export { PointPicker, decodePickSample } from './point-picker.js';
export type { PointPickNode, DecodedPickSample } from './point-picker.js';
export type { PointPickSizing } from './picker.js';

// Point cloud rendering (Phase 0: IFCx inline; Phase 1+: streaming LAS/LAZ)
export { PointCloudRenderer } from './pointcloud/point-cloud-renderer.js';
export type {
    PointCloudAssetHandle,
    PointCloudRenderOptions,
    PointColorMode,
    PointSizeMode,
    ResolvedSectionPlane as PointResolvedSectionPlane,
} from './pointcloud/point-cloud-renderer.js';
export { PointRenderPipeline } from './pointcloud/point-pipeline.js';
export type {
    PointCloudChunkInput,
    PointCloudNode,
    PointCloudNodeMeta,
} from './pointcloud/point-cloud-node.js';

import { WebGPUDevice } from './device.js';
import { RenderPipeline } from './pipeline.js';
import { Camera } from './camera.js';
import { Scene, type InstancedTemplateGPU } from './scene.js';
import { Picker } from './picker.js';
import { MathUtils, viewBasis } from './math.js';
import { FrustumUtils } from '@ifc-lite/spatial';
import type { MeshData } from '@ifc-lite/geometry';
import type {
    RenderOptions,
    PickOptions,
    PickResult,
    PickClipState,
    ClipBox,
    Mesh,
    BatchedMesh,
} from './types.js';
import { VisualEnhancementResolver } from './visual-enhancement.js';
import { packClipBox } from './clip-box.js';
import type { CutPolygon2D, DrawingLine2D } from './section-2d-overlay.js';
import type {
  SymbolicFillInput,
  SymbolicTextInput,
} from './symbolic-overlay-pipelines.js';
import { RendererOverlays } from './renderer-overlays.js';
import { resolveSectionPlaneFrame } from './render-section-plane.js';
import { Raycaster, type Intersection } from './raycaster.js';
import { SnapDetector, type SnapTarget, type SnapOptions, type EdgeLockInput, type MagneticSnapResult } from './snap-detector.js';
import { PickingManager } from './picking-manager.js';
import { RaycastEngine } from './raycast-engine.js';
import { RenderDegradationMonitor, type RenderDegradationInfo } from './render-degradation.js';
import { PostProcessor } from './post-processor.js';
import { InteractionEffectsGovernor } from './interaction-effects-governor.js';
import { VisibilityEpochTracker } from './visibility-epoch.js';
import { isEntityVisible } from './entity-visibility.js';
import { ModelBoundsTracker, type ModelBoundsBox } from './model-bounds-tracker.js';
import { resolveContributionThresholdPx, projectedAabbRadiusPx, projectedInstancedRadiusPx, type CullCameraState } from './contribution-cull.js';
import type { FrameStats } from './render-stats.js';
import { EdlPass } from './edl-pass.js';
import { SkyPass } from './sky-pass.js';
import { skyShaderSource } from './shaders/sky.wgsl.js';
import { resolveEnvironment } from './environment.js';
import { shouldRouteMeshTransparent, shouldRouteBatchTransparent, splitVisibleIdsByPromotion, DEFAULT_GHOST_ALPHA } from './overlay-routing.js';
import { colorSaltByte, packEntityLane } from './scene-geometry.js';
import { PointCloudRenderer } from './pointcloud/point-cloud-renderer.js';
import type { PointCloudAsset } from '@ifc-lite/geometry';
import { DeviationPipeline } from './deviation/deviation-pipeline.js';
import { buildTriangleBVH } from './deviation/triangle-bvh.js';

const MAX_ENCODED_ENTITY_ID = 0xFFFFFF;
let warnedEntityIdRange = false;

/**
 * Build a deterministic fingerprint of the BVH input mesh set so
 * `Renderer.computeDeviations` can skip the rebuild when the source
 * geometry hasn't changed. Folds in expressId / modelIndex / position
 * + index lengths per mesh so two distinct mesh sets that happen to
 * share the same aggregate position-length total can't collide on the
 * same fingerprint and reuse a stale BVH.
 */
function computeBvhFingerprint(meshes: ReadonlyArray<import('@ifc-lite/geometry').MeshData>): string {
    const parts: string[] = [String(meshes.length)];
    for (const m of meshes) {
        const id = m.expressId ?? -1;
        const mi = m.modelIndex ?? -1;
        const posLen = m.positions?.length ?? 0;
        const idxLen = m.indices?.length ?? 0;
        parts.push(`${id}:${mi}:${posLen}:${idxLen}`);
    }
    return parts.join('|');
}

/**
 * Is this throw the GPU device telling us it is gone?
 *
 * The discriminator is the exception TYPE, not its message, because WebGPU
 * draws exactly that line:
 *  - a call on a dead / invalid-state device throws a `DOMException`
 *    (`InvalidStateError` in Safari 26.5 — the whole of issue #2229);
 *  - a buffer allocation the host cannot back throws a plain `RangeError`
 *    ("createBuffer failed, size (…) is too large … when mappedAtCreation ==
 *    true"), which `gpu-upload-guard` documents happening on a HEALTHY device
 *    under memory pressure.
 *
 * Treating the second as a device loss is a false positive that costs the whole
 * session, so only the first latches; everything else degrades one frame.
 *
 * There is deliberately NO consecutive-failure threshold as a middle ground.
 * Not because failures necessarily arrive back-to-back — between two BCF / IDS
 * capture frames the awaited `camera.frameBounds` normally does let an ordinary
 * rAF frame through, which would reset a counter — but because those ordinary
 * frames are not guaranteed to SUCCEED: they allocate too (`ensureMeshResources`
 * creates a buffer per unresourced mesh, and the queued-mesh flush allocates),
 * so under sustained host memory pressure any finite budget is still reachable.
 * A latch whose safety depends on incidental animation timing is the wrong
 * shape of guarantee for "never kill the viewport by mistake".
 *
 * Real losses on browsers that do not throw are still caught by the async
 * `device.lost` promise — which the WebGPU spec makes the sole loss channel
 * anyway (on a conformant engine, calls against a lost device are no-ops, not
 * throws; Safari 26.5's synchronous throw is the deviation being handled here).
 *
 * `typeof` guarded because non-DOM hosts (Node before 17, some workers) have no
 * `DOMException` global; there, no throw can be a WebGPU device signal anyway.
 */
function isDeviceLossThrow(error: unknown): boolean {
    return typeof DOMException !== 'undefined' && error instanceof DOMException;
}

/**
 * The reason `whenReady()` rejects when the renderer is destroyed.
 *
 * A plain `Error` carrying a stable `name` rather than an exported subclass:
 * consumers can discriminate it with `err.name === 'RendererDestroyedError'`
 * without this package growing a new export (and without `instanceof` breaking
 * across duplicated copies of the package).
 */
function rendererDestroyedError(): Error {
    const error = new Error('Renderer was destroyed before it became ready');
    error.name = 'RendererDestroyedError';
    return error;
}

/**
 * The reason `whenReady()` rejects once the GPU device has been lost.
 *
 * Deliberately NOT `RendererDestroyedError`: a destroyed renderer is finished,
 * while a lost one is dead only until the host re-initialises it (`init()`
 * clears the latch and readiness is published again). A caller that wants to
 * retry needs to tell those apart, so the loss carries its own `name` — same
 * plain-`Error` shape, for the same reasons.
 */
function rendererDeviceLostError(): Error {
    const error = new Error('GPU device was lost before the renderer became ready');
    error.name = 'RendererDeviceLostError';
    return error;
}

/**
 * Main renderer class
 */
export class Renderer {
    private device: WebGPUDevice;
    private pipeline: RenderPipeline | null = null;
    private camera: Camera;
    private scene: Scene;
    private picker: Picker | null = null;
    private canvas: HTMLCanvasElement;
    /**
     * Section-plane gizmo, 2D section drawing/cap, and the standalone 3D line
     * + symbolic annotation overlays (issue #2425). Created here rather than in
     * `init()` so a pre-init `setOverlayLineColor` still lands — the GPU
     * objects inside stay null until `init()` calls `overlays.init()`.
     */
    private readonly overlays = new RendererOverlays({
        getModelBounds: () => this.getModelBounds(),
        expandModelBoundsWithFlatVertices: (positions, stride) =>
            this.modelBoundsTracker.expandWithFlatVertices(positions, stride),
        syncCameraSceneBounds: () => {
            if (this.modelBounds) this.camera.setSceneBounds(this.modelBounds);
        },
        requestRender: () => this.requestRender(),
    });
    private postProcessor: PostProcessor | null = null;
    private readonly interactionEffects = new InteractionEffectsGovernor();
    private edlPass: EdlPass | null = null;
    // Procedural sky background — created lazily on the first frame that
    // enables it (most sessions never do).
    private skyPass: SkyPass | null = null;
    private edlOptions: { enabled: boolean; strength: number; radiusPx: number; highQuality: boolean } = {
        enabled: false,
        strength: 1,
        radiusPx: 1,
        highQuality: true,
    };
    private pointCloudRenderer: PointCloudRenderer | null = null;
    /**
     * Set true at the end of the LATEST `init()`; gates `whenReady()` and
     * `isReady()`. Revoked synchronously by `init()` and by `destroy()`, and
     * overridden (not cleared) by a device loss — see `deviceLost`, which the
     * two readiness methods consult alongside this flag because the loss can
     * land in the middle of the init that is about to set it.
     */
    private ready = false;
    private readyWaiters: Array<{ resolve: () => void; reject: (reason: Error) => void }> = [];

    /**
     * Set by the public `destroy()`, cleared synchronously by `init()`. It is
     * the difference between "not ready YET" and "never going to be ready":
     * `whenReady()` parks for the first and rejects for the second.
     *
     * Without it a caller parked across the teardown waits forever, because
     * nothing after `destroy()` will ever reach `markReady()` — the host's
     * remount builds a NEW Renderer rather than re-initialising this one. The
     * private `teardown()` deliberately does NOT set it: the teardown
     * `initOnce()` runs on the previous init's objects is part of an init that
     * IS going to publish readiness, and its waiters must survive to be flushed.
     */
    private destroyed = false;

    /**
     * The tail of the `init()` queue. `init()` chains onto this rather than
     * running immediately, so two overlapping calls cannot both walk past the
     * "a previous init completed" guard while the first is still awaiting its
     * device and both allocate a full set of GPU objects (#2448). Always
     * settled fulfilled — a rejected init is swallowed HERE (never for the
     * caller) so one failure does not deadlock every later call.
     */
    private initChain: Promise<void> = Promise.resolve();

    /**
     * Incremented synchronously by every `init()` call AND by every public
     * `destroy()`. It stamps "the lifecycle event an in-flight init belongs to":
     * an init that no longer carries the current stamp has been superseded and
     * must neither allocate nor publish readiness.
     *
     * Both bumps are load-bearing, for the same reason. Because the queue above
     * defers the body, an init can finish while a later one is still waiting its
     * turn; that later call is about to tear down everything the earlier one
     * built, so the earlier one must not publish readiness. And a host that calls
     * `destroy()` while an init is parked on `await device.init(...)` gets the
     * same hazard from the other direction: without the bump that init resumes,
     * allocates a full replacement GPU stack nothing references, and re-publishes
     * `ready` against a renderer that has already been torn down (#2465).
     *
     * The teardown `initOnce()` runs as part of its OWN re-init deliberately does
     * NOT bump it — see `destroy()` vs `teardown()`. Bumping there would make
     * every re-init invalidate itself, and nothing would ever become ready again.
     */
    private initGeneration = 0;

    /**
     * Set once the GPU device is lost for a non-intentional reason (driver
     * reset / VRAM exhaustion — see `WebGPUDevice`). Every GPU resource is then
     * dead, so `render()` becomes a no-op (it would only spew validation errors)
     * and the renderer stops reporting itself ready (`isReady()` goes false,
     * `whenReady()` rejects) until the host re-initialises it. Consumers learn
     * of this via `onDeviceLost` and typically respond by reloading the model.
     *
     * Two signals set it: the async `device.lost` promise (Chromium), and a
     * frame throwing a `DOMException` out of `render()` (Safari 26.5, which
     * reports the loss synchronously — issue #2229). Whichever arrives first
     * latches. A frame throwing anything else does NOT latch (see
     * `isDeviceLossThrow`) — that class is host memory pressure on a live
     * device, and it must cost one frame, not the session.
     */
    private deviceLost = false;
    /**
     * The lifecycle generation the latched loss belongs to (see
     * `initGeneration`); null until the first loss, and never cleared
     * afterwards. It is only ever read next to `deviceLost`, which is what
     * makes a stale stamp harmless — and that pairing is required, not
     * cosmetic: a loss that latched between `init()` bumping the generation and
     * its queued body running is stamped with the CURRENT generation, and only
     * the flag that body clears says the renderer has moved on.
     *
     * `whenReady()` rejects only while this still equals the CURRENT generation,
     * which is what re-arms the wait the instant a host calls `init()` — before
     * the queued body has had a chance to clear `deviceLost` itself. Without
     * that, `renderer.init(); await renderer.whenReady();` — the recovery shape
     * `init()` already revokes readiness synchronously for — would reject inside
     * the microtask window on a renderer that is being brought back up.
     *
     * Scoping it here rather than clearing `deviceLost` in `init()` keeps the
     * flag meaning exactly one thing everywhere else: `render()`, the pick path
     * and `getGPUDevice()` must stay shut for the OLD device across that same
     * window, and clearing early would let frames run against dead GPU objects
     * (and, on Safari, re-latch and re-notify the loss they already reported).
     */
    private deviceLostGeneration: number | null = null;
    /** Retained so a listener registered AFTER the loss still learns of it. */
    private deviceLostInfo: { message: string; reason: string } | null = null;
    private deviceLostListeners = new Set<(info: { message: string; reason: string }) => void>();
    private deviationPipeline: DeviationPipeline | null = null;
    /**
     * Cache of which mesh-set the BVH was built from. We rebuild on
     * `computeDeviations` only when the cached "fingerprint" misses,
     * so re-running deviation against the same model is a fast
     * dispatch — the BVH is multi-second on big BIMs and we don't
     * want to pay that on every slider drag.
     */
    private deviationBvhFingerprint: string | null = null;
    private readonly visualEnhancementResolver = new VisualEnhancementResolver();

    // Model bounds for fitToView, section planes, camera. The value itself
    // lives in ModelBoundsTracker (issue #2425) so the four writers — point
    // cloud upload, mesh load, overlay upload, and the public setModelBounds —
    // share one owner instead of a private field. Camera notification stays at
    // the call sites: they do not all push under the same policy.
    private readonly modelBoundsTracker = new ModelBoundsTracker({
        meshBounds: () => this.computeMeshBounds(),
        pointCloudBounds: () => this.pointCloudRenderer?.getBounds() ?? null,
    });

    /** Read-only view of the tracked scene AABB (live reference, not a copy). */
    private get modelBounds(): ModelBoundsBox | null {
        return this.modelBoundsTracker.get();
    }

    // Composition: delegate to extracted managers
    private pickingManager: PickingManager;
    private raycastEngine: RaycastEngine;

    // Error rate limiting (log at most once per second). -Infinity, not 0:
    // performance.now() is below 1000 during the first second of page life, so
    // a 0 start would silently suppress the FIRST render/device-loss error —
    // exactly the evidence worth keeping.
    private lastRenderErrorTime: number = -Infinity;
    private readonly RENDER_ERROR_THROTTLE_MS = 1000;
    /**
     * Consecutive frames that threw a non-device error and were degraded.
     * Reset by any frame that completes. Gates the self-retry in `render()`'s
     * catch — see there for why it is a retry budget and not a latch — and,
     * since #2417, the persistent-degradation report as well. Both readings
     * depend on the reset: this is the length of the CURRENT unbroken run of
     * failures, never a session total (`_renderErrorCount` is that, and using
     * it for either purpose would count failures the viewport recovered from).
     */
    private consecutiveDegradedFrames = 0;
    /**
     * How many consecutive degraded frames may re-request themselves. Three is
     * a blink at 60 Hz — enough for a transient host-memory spike to clear
     * without the user touching anything, far too few to matter as wasted work
     * if it does not. Beyond it the viewport goes quiet rather than spinning,
     * and the next interaction/stream/animation drives it as normal.
     */
    private readonly MAX_DEGRADED_SELF_RETRIES = 3;
    /**
     * Decides when degrading has stopped being transient (issue #2417). The
     * non-latching branch is correct per occurrence and blind in aggregate: a
     * failure that never clears leaves a wedged viewport that looks, from
     * outside, exactly like one that recovered. Fires once per session.
     */
    private readonly renderDegradation = new RenderDegradationMonitor();
    private persistentDegradationListeners = new Set<(info: RenderDegradationInfo) => void>();
    /**
     * Set by `containFrameThrow` for the frame currently in flight, cleared by
     * `render()` before each one.
     *
     * Needed because the encode region's catch is INSIDE `renderFrame()`, and
     * it swallows its throw: a frame that failed there returns to `render()`
     * perfectly normally, so "did not throw" is not the same question as "did
     * not fail". Without this flag `render()` reads it as a completed frame and
     * resets `consecutiveDegradedFrames` on the very next line — which makes
     * `++count <= MAX_DEGRADED_SELF_RETRIES` true on EVERY encode failure, so
     * the retry budget never exhausts and a persistently failing encode path
     * re-requests one throwing frame per rAF forever. It also caps the run
     * length at 1, so no persistent-degradation report could ever fire for the
     * region this PR exists to cover.
     */
    private frameContainedThrow = false;

    // Diagnostic counters for mobile debugging
    private _renderCallCount: number = 0;
    private _renderSkipCount: number = 0;
    /** Snapshot of the last completed render() — see getFrameStats(). */
    private _lastFrameStats: FrameStats | null = null;
    private _renderErrorCount: number = 0;
    private _lastRenderError: string = '';


    // Dirty flag: set by requestRender(), consumed by the animation loop.
    // Centralises all render scheduling — callers never call render() directly.
    private _renderRequested: boolean = false;

    // ─── Visibility-change bookkeeping (per-frame perf + leak fixes) ─────────
    // Hide/isolate changes are detected by CONTENT (snapshot compare in the
    // tracker), so callers may either mutate the same Set in place or pass a
    // fresh Set per frame — see the RenderOptions.hiddenIds contract.
    // `_visibilityVersion` drives the per-batch visibility cache;
    // `_partialBatchEpoch` additionally folds colour-override changes so the
    // partial sub-batch cache fast path stays correct.
    private readonly _visibilityEpochs = new VisibilityEpochTracker();
    private _visibilityVersion: number = 0;
    private _partialBatchEpoch: number = 0;
    private _lastColorOverrideGen: number = -1;
    private _lastHadVisibilityFiltering: boolean = false;
    // Cached per-batch visibility, valid only while `_batchVisibilityEpoch`
    // matches `_visibilityVersion`. Avoids the O(total element count) recompute
    // (+ per-batch visible-id Set allocation) every frame while hide/isolate
    // holds. Keyed by batch object (immutable expressIds per instance); a
    // rebuilt batch is a new object → recomputed lazily. WeakMap, not Map:
    // residency eviction/restore churn while ONE filter epoch holds (e.g. a
    // schedule animation) would otherwise pin every dead batch object until
    // the next visibility change.
    private _batchVisibilityEpoch: number = -1;
    private _batchVisibilityCache = new WeakMap<
        BatchedMesh,
        { visible: boolean; fullyVisible: boolean; visibleIds?: Set<number> }
    >();
    // Selection snapshot from the previous frame — a change triggers disposal of
    // now-unselected hydrated meshes (leak + double-draw fix). The model index
    // is part of the snapshot: federated models can share express ids, so a
    // same-id selection in ANOTHER model is still a change that must free the
    // old model's hydrated mesh.
    private _prevHydratedSelection: Set<number> = new Set();
    private _prevHydratedSelectionModelIndex: number | undefined = undefined;

    // One-shot log guard — prints Y-up clip bounds on first section-enable so
    // users can confirm the slider is operating on the intended range.
    private _loggedSectionBounds: boolean = false;

    // Pooled per-frame buffers to avoid GC pressure from per-batch Float32Array allocations
    // A single 224-byte uniform buffer (56 floats) is reused for all batches/meshes within a frame
    // (48 floats viewProj…flags + 8 floats clipBoxMin/clipBoxMax)
    // 60 floats = the WGSL Uniforms struct incl. quantParams (see
    // pipeline.getUniformBufferSize).
    private readonly uniformScratch = new Float32Array(60);
    private readonly uniformScratchU32 = new Uint32Array(this.uniformScratch.buffer, 176, 4);

    // What the last render() actually clipped, so the GPU picker can mirror it and
    // section/crop-clipped geometry stays unpickable, not just invisible. Updated
    // every render; read by pick()/pickRect(). null = nothing clipped that frame.
    private _activePickSection: { normal: [number, number, number]; distance: number; flipped: boolean } | null = null;
    private _activePickClipBox: ClipBox | null = null;

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
        this.device = new WebGPUDevice();
        this.camera = new Camera();
        this.scene = new Scene();

        // Create composition managers
        this.pickingManager = new PickingManager(this.camera, this.scene, null, this.canvas, (meshData: MeshData) => this.createMeshFromData(meshData));
        this.raycastEngine = new RaycastEngine(this.camera, this.scene, this.canvas);
    }

    /**
     * Initialize renderer.
     *
     * Safe to call on an already-initialised instance: the previous GPU objects
     * are released first. The comment below advertises a `destroy()` + `init()`
     * re-init flow, and the obvious device-loss auto-recovery is to call
     * `init()` on the live instance — which, without this, silently orphaned
     * two render pipelines, the picker, the post-processor, the point-cloud and
     * deviation pipelines, the EDL pass and the overlay layer's glyph atlas, per
     * recovery (#2448). Making the method self-safe is cheaper than trusting
     * every future caller to remember.
     *
     * Concurrent calls are SERIALISED, not coalesced: the second waits for the
     * first to settle and then runs in full. Without that, `pipeline` — which
     * only ever marks a COMPLETED init — is still null while the first call is
     * awaiting `device.init()`, so both calls sail past the guard above and both
     * allocate a full set of GPU objects, orphaning the first. Queueing turns
     * the concurrent case into the sequential one the guard already handles,
     * rather than adding a second, differently-shaped rule.
     */
    async init(): Promise<void> {
        // Revoke readiness SYNCHRONOUSLY, before the body is queued. Everything
        // below runs in a later microtask (or, for a queued call, only after the
        // one ahead of it settles), so leaving `ready` set would let
        // `renderer.init(); await renderer.whenReady();` resolve immediately
        // against the GPU objects this init is about to destroy — the very
        // hazard the re-arm inside `initOnce()` exists to prevent. On a first
        // init there is nothing to invalidate and this is a no-op.
        const generation = ++this.initGeneration;
        this.ready = false;
        // Re-arm `whenReady()`: this instance is being brought back up, so a
        // wait requested from here on is "not ready yet" again, not "destroyed".
        this.destroyed = false;
        // A previous init that REJECTED must not block the next one, so the
        // stored link swallows the outcome. The caller still receives `run`, so
        // rejections continue to surface exactly as before.
        const run = this.initChain.then(() => this.initOnce(generation), () => this.initOnce(generation));
        this.initChain = run.then(() => undefined, () => undefined);
        return run;
    }

    private async initOnce(generation: number): Promise<void> {
        // `pipeline` is the marker for "a previous init() completed": it is
        // assigned unconditionally there and nulled by destroy().
        if (this.pipeline !== null) {
            // Release the device the previous init() resolved on, and re-arm
            // `whenReady()` so it cannot resolve against GPU objects that no
            // longer exist. `teardown()`, not the public `destroy()`: this
            // teardown is part of THIS init, so it must not invalidate this
            // init's own generation.
            this.teardown();
        }
        // Clear the lost flag so a re-init (destroy()+init() on the same instance)
        // resumes rendering instead of staying a permanent no-op from an earlier loss.
        // This also releases `whenReady()`'s rejection for the one case the
        // generation stamp cannot: a loss that latched between `init()` bumping
        // the generation and this body running is stamped with the generation
        // that is clearing it. `deviceLostGeneration` deliberately keeps its
        // stale value — it is only ever read alongside this flag.
        this.deviceLost = false;
        // Subscribe before the device exists so a loss during the first frames
        // is never missed — the handler is only invoked when `device.lost`
        // actually resolves (a real fault), long after init in practice.
        this.device.onDeviceLost((info) => this.handleDeviceLost(info));
        await this.device.init(this.canvas);

        // A `destroy()` (or a newer `init()`) landed while we were parked on the
        // device. Everything below allocates a full GPU stack — two pipelines,
        // the picker, the post-processor, the point-cloud and deviation
        // pipelines, the EDL pass, the overlay glyph atlas — and this aborted
        // path runs no second teardown, so all of it would be orphaned outright
        // (#2465). `markReady()`'s generation check is not enough on its own: it
        // withholds the readiness PUBLICATION, not the allocation. Release the
        // device we just brought up and stop here; a queued init will bring up
        // its own.
        if (generation !== this.initGeneration) {
            this.device.destroy();
            return;
        }

        // Get canvas dimensions (use pixel dimensions if set, otherwise use CSS dimensions)
        // and clamp to the GPU's max 2D texture dimension so the initial pipeline allocations
        // can't overflow on tall/wide layouts (see render() for the per-frame clamp).
        const rect = this.canvas.getBoundingClientRect();
        const maxDim = this.device.getMaxTextureDimension();
        const rawWidth = this.canvas.width || Math.max(1, Math.floor(rect.width));
        const rawHeight = this.canvas.height || Math.max(1, Math.floor(rect.height));
        const width = Math.min(rawWidth, maxDim);
        const height = Math.min(rawHeight, maxDim);

        // Set pixel dimensions if not already set, or if we clamped them down
        if (!this.canvas.width || !this.canvas.height || this.canvas.width !== width || this.canvas.height !== height) {
            this.canvas.width = width;
            this.canvas.height = height;
        }

        this.pipeline = new RenderPipeline(this.device, width, height);
        this.picker = new Picker(this.device, width, height);
        this.overlays.init(
            this.device.getDevice(),
            this.device.getFormat(),
            this.pipeline.getSampleCount(),
        );
        // PostProcessor is optional — if it fails (e.g. mobile GPU lacking
        // depth TEXTURE_BINDING), rendering still works without post-processing.
        try {
            this.postProcessor = new PostProcessor(this.device, {
                enableContactShading: true,
                contactRadius: 1.0,
                contactIntensity: 0.3,
            }, this.pipeline.getSampleCount());
        } catch (e) {
            console.warn('[Renderer] PostProcessor init failed (post-processing disabled):', e);
            this.postProcessor = null;
        }
        this.pointCloudRenderer = new PointCloudRenderer(
            this.device.getDevice(),
            this.device.getFormat(),
            'depth24plus-stencil8',
            this.pipeline.getSampleCount(),
        );
        // Compute pipeline for the BIM↔scan deviation heatmap. Lazily
        // owns the per-triangle BVH GPU buffers; idle until the first
        // `computeDeviations` call.
        this.deviationPipeline = new DeviationPipeline(this.device.getDevice());
        this.edlPass = new EdlPass(this.device, this.pipeline.getSampleCount());
        this.camera.setAspect(width / height);

        // Update picking manager with initialized picker
        this.pickingManager.setPicker(this.picker);
        // Provide a snapshot of pickable point nodes per pick. The
        // sizing must mirror the live splat shader so click hit-testing
        // matches what the user actually sees on screen.
        this.pickingManager.setPointPickProvider(() => {
            const pcr = this.pointCloudRenderer;
            if (!pcr || !pcr.hasAssets()) return null;
            const opts = pcr.getOptions();
            const sizeMode = opts.sizeMode === 'fixed-px' ? 0 : opts.sizeMode === 'adaptive-world' ? 1 : 2;
            return {
                nodes: pcr.getPickNodes(),
                sizing: {
                    sizeMode: sizeMode as 0 | 1 | 2,
                    worldRadius: opts.worldRadius,
                    pointSizePx: opts.pointSize,
                    clickTolerancePx: 2,
                },
            };
        });
        // Let the CPU raycast engine (measure tool / snap) query each
        // point-cloud asset's spatial index (#1860) — a separate concern
        // from the GPU click-pick provider above, since raycastScene* is
        // synchronous CPU code while pick() is an async GPU readback.
        this.raycastEngine.setPointCloudProvider(() => this.pointCloudRenderer?.getRayQuerySources() ?? []);

        this.markReady(generation);
    }

    /**
     * Resolves once `init()` has finished and the GPU device + point-cloud
     * renderer are usable. Callers that may run before init completes — e.g.
     * dropping a point cloud immediately after the viewport mounts, before
     * the async WebGPU init resolves — should `await renderer.whenReady()`
     * before `beginPointCloudStream`, which otherwise throws
     * "Renderer not initialized".
     *
     * REJECTS (with an `Error` whose `name` is `RendererDestroyedError`) if
     * `destroy()` runs while the caller is waiting, or if it already ran and no
     * `init()` has been started since. It never resolves against a destroyed
     * renderer — that is what this method exists to prevent — so the only
     * alternative would be a promise that never settles, which suspends the
     * caller's async frame permanently and takes everything the frame captured
     * with it. The viewer reaches that state on an ordinary path: `Viewport`
     * builds a NEW `Renderer` per mount and destroys the old one in its effect
     * cleanup, so a `destroy()` there is FINAL for the instance a consumer
     * captured — a point-cloud drop that straddles a layout swap or a
     * StrictMode remount would otherwise hang mid-load, with no error, forever.
     * Callers should handle the rejection as "the target went away", not as a
     * load failure.
     *
     * It also REJECTS (`RendererDeviceLostError`) while the GPU device is lost.
     * The device is what this method promises, and a lost one cannot serve the
     * call the caller is waiting to make — `getGPUDevice()` returns null, so
     * `beginPointCloudStream` throws "Renderer not initialized" the moment the
     * wait resolves. The third outcome is the one `destroy()` already ruled out:
     * parking a waiter that only a host-initiated `init()` could ever settle,
     * and that the viewer's usual response to a loss (drop this renderer, build
     * a new one) guarantees will never come. Unlike the destroyed case this is
     * NOT final — a later `init()` on the same instance re-arms the wait
     * synchronously, so "retry after re-init" is a contract callers can act on,
     * which is why the two rejections carry different names.
     */
    whenReady(): Promise<void> {
        // Checked before `ready`, which an init that completed after the loss
        // latched may well have published (`init()` subscribes to the device's
        // loss signal before awaiting it, so a loss DURING init leaves both
        // flags set). Readiness is about the device, and the device is gone.
        if (this.deviceLost && this.deviceLostGeneration === this.initGeneration) {
            return Promise.reject(rendererDeviceLostError());
        }
        if (this.ready) return Promise.resolve();
        if (this.destroyed) return Promise.reject(rendererDestroyedError());
        return new Promise<void>((resolve, reject) => { this.readyWaiters.push({ resolve, reject }); });
    }

    private markReady(generation: number): void {
        // A newer init() is already queued: it will tear all of this down before
        // building its own, so publishing readiness here would hand callers a
        // device with a demolition order on it.
        if (generation !== this.initGeneration) return;
        this.ready = true;
        const waiters = this.readyWaiters;
        this.readyWaiters = [];
        for (const w of waiters) w.resolve();
    }

    /**
     * Fail every parked `whenReady()` waiter with `error`. Called by `destroy()`
     * and by `handleDeviceLost()` — the two events after which nothing this
     * instance does on its own can make the wait true. NOT by `teardown()`,
     * whose waiters belong to the re-init running it and must survive to be
     * flushed by it.
     */
    private rejectReadyWaiters(error: Error): void {
        const waiters = this.readyWaiters;
        this.readyWaiters = [];
        for (const w of waiters) w.reject(error);
    }

    /**
     * Subscribe to non-intentional GPU device loss (driver reset / VRAM
     * exhaustion — NOT an intentional `destroy()`). Fired at most once per
     * device. After it fires, `render()` is a no-op and the renderer reports
     * itself un-ready (`isReady()` false, `whenReady()` rejecting with
     * `RendererDeviceLostError`) until it is re-initialised, so the typical
     * response is to dispose this renderer and reload the model. Returns an
     * unsubscribe function.
     *
     * Camera and model state live on the CPU (JS) and survive device loss, so a
     * reload restores the model at its current orientation — the loss is a GPU
     * event, not a data loss.
     */
    onDeviceLost(listener: (info: { message: string; reason: string }) => void): () => void {
        this.deviceLostListeners.add(listener);
        // Replay a loss that already happened. `init()` subscribes to the
        // device's own loss signal BEFORE awaiting `device.init()`, so a loss
        // during initialisation latches while `deviceLostListeners` is still
        // empty — and the viewer's subscriber cannot register any earlier,
        // because it needs init() to have resolved. Without this replay that
        // loss reaches nobody: the renderer correctly goes quiet and the user
        // sees a viewer that simply stopped, with no toast and no capture.
        if (this.deviceLost && this.deviceLostInfo !== null) {
            try {
                listener(this.deviceLostInfo);
            } catch (e) {
                console.error('[Renderer] onDeviceLost listener threw:', e);
            }
        }
        return () => this.deviceLostListeners.delete(listener);
    }

    /**
     * Subscribe to the renderer having degraded frame after frame without
     * recovering (issue #2417). Distinct from `onDeviceLost`: the device is
     * still alive by every signal available, which is exactly why `render()`
     * refuses to latch on these throws — but the user is looking at a viewport
     * that has stopped updating, and until this callback existed nothing said
     * so. Fired at most once per renderer, once `PERSISTENT_DEGRADATION_FRAMES`
     * frames have degraded CONSECUTIVELY — any frame that completes resets the
     * run, so a session that failed occasionally and recovered every time never
     * reports. Returns an unsubscribe function.
     *
     * No replay for a late subscriber, unlike `onDeviceLost` — a loss can latch
     * during `init()`, before any subscriber can exist, but a degraded frame
     * cannot: `renderFrame()` returns early while `pipeline` is null, so the
     * count only moves once the host is driving frames, which is strictly after
     * `init()` resolved and the host subscribed.
     */
    onPersistentRenderDegradation(listener: (info: RenderDegradationInfo) => void): () => void {
        this.persistentDegradationListeners.add(listener);
        return () => this.persistentDegradationListeners.delete(listener);
    }

    /** True once the GPU device has been lost for a non-intentional reason. */
    isDeviceLost(): boolean {
        return this.deviceLost;
    }

    private handleDeviceLost(info: { message: string; reason: string }): void {
        if (this.deviceLost) return;
        this.deviceLost = true;
        this.deviceLostGeneration = this.initGeneration;
        this.deviceLostInfo = info;
        console.warn('[Renderer] GPU device lost — halting rendering until re-init:', info.message);
        // Readiness describes the GPU objects, and every one of them just died:
        // `isReady()` reports it from here on, and anyone parked in
        // `whenReady()` is failed rather than left to be resolved by the init
        // this loss may have landed in the middle of. Done BEFORE the listeners
        // run, so a listener that recovers by calling `init()` synchronously
        // finds the waiters already settled and re-arms the wait for the next
        // caller rather than racing the flush.
        this.rejectReadyWaiters(rendererDeviceLostError());
        for (const listener of this.deviceLostListeners) {
            try {
                listener(info);
            } catch (e) {
                console.error('[Renderer] onDeviceLost listener threw:', e);
            }
        }
    }

    /**
     * Contain a throw that escaped part of a frame, and decide what it meant.
     *
     * ONE body for both of `render()`'s catches (issue #2417). They used to
     * differ in the only way that matters: the outer one discriminated on
     * `isDeviceLossThrow`, the encode-region one did not, so a device that died
     * after `getCurrentTexture()` succeeded degraded quietly forever — no latch,
     * no toast, no `onDeviceLost`. Sharing the body is what stops the two
     * halves of one policy drifting apart again.
     *
     * Callers keep only what is genuinely theirs: the outer catch counts the
     * frame as a skip, the encode catch balances the validation error scope
     * first. `origin` distinguishes them in logs and in the degradation report.
     */
    private containFrameThrow(error: unknown, origin: 'frame' | 'encode'): void {
        // Recorded for BOTH branches, before either is chosen: the caller in
        // the encode region is about to return normally either way, and
        // `render()` must not mistake that for a frame that succeeded.
        this.frameContainedThrow = true;
        this._renderErrorCount++;
        const message = error instanceof Error ? error.message : String(error);
        this._lastRenderError = message;

        if (isDeviceLossThrow(error)) {
            // Reached at most once per device: the `deviceLost` early return in
            // render() short-circuits every later frame. Logged with the
            // original error to keep the stack.
            console.error(
                `[Renderer] Frame threw a DOMException (${origin}) — treating as device loss:`,
                error,
            );
            this.handleDeviceLost({
                message,
                reason: origin === 'encode' ? 'render-encode-exception' : 'render-exception',
            });
            return;
        }

        // Not a device signal — cost this FRAME, never the session. Both
        // regions really do have such a source on a HEALTHY device: the outer
        // one runs `scene.restoreAllEvicted()` for capture frames, the encode
        // one builds visibility sub-batches through
        // `scene.getOrCreatePartialBatch()`, and both allocate via
        // `createBuffer({ mappedAtCreation: true })`, which throws a plain
        // `RangeError` under host memory pressure — the failure
        // `gpu-upload-guard` documents verbatim. Latching there would kill the
        // viewport for a failure whose blast radius should be one frame, and
        // would raise a false "graphics device was lost" toast plus false
        // `device_lost` telemetry on top.
        //
        // Invalidate the swap-chain configuration so the next frame
        // reconfigures.
        this.device.invalidateContext();
        // ...and ask for that next frame. The host loop CONSUMES the dirty flag
        // before calling render(), so a frame that fails has already spent its
        // request: on an idle viewer (no animation, no streaming, no
        // interaction) nothing would re-dirty it and the failed frame would be
        // the last one drawn until the user happened to touch something.
        // "Degrade and continue" has to mean the next frame actually comes, or
        // it is only "degrade and hope".
        //
        // Bounded, and reset by any successful frame, so a persistently failing
        // path cannot self-perpetuate one throwing frame per rAF forever. NOTE
        // this is a RETRY budget, not a latch threshold: exhausting it stops us
        // re-requesting, leaving the app's own dirty signals (interaction,
        // streaming, animation) to drive — it never disables the renderer.
        // Worst case is a stale viewport that any interaction revives, not a
        // dead session.
        if (++this.consecutiveDegradedFrames <= this.MAX_DEGRADED_SELF_RETRIES) {
            this.requestRender();
        }
        // Per-frame degradation is the right call and an aggregate blind spot:
        // report the session once it is clear the failure is not clearing.
        this.notePersistentDegradation(message, origin);

        const now = performance.now();
        if (now - this.lastRenderErrorTime > this.RENDER_ERROR_THROTTLE_MS) {
            this.lastRenderErrorTime = now;
            console.warn(
                `[Renderer] Frame threw in ${origin} (device assumed alive; context will be reconfigured):`,
                error,
            );
        }
    }

    /**
     * Fan out the once-per-session "this viewport is not recovering" report.
     * The renderer files no telemetry itself (it is host-agnostic and must stay
     * PostHog-free); the host subscribes and routes it through whatever it
     * already uses for device loss.
     */
    private notePersistentDegradation(detail: string, origin: 'frame' | 'encode'): void {
        // `consecutiveDegradedFrames`, NOT `_renderErrorCount`. The latter is a
        // renderer-LIFETIME total that no successful frame ever resets, so it
        // would turn the threshold into "the 16th failure ever" — reached by a
        // long healthy session that hit four isolated spikes an hour apart and
        // recovered from every one of them. The signal is meant to mean "this
        // viewport has stopped", and only an unbroken run means that. The
        // reset lives in `render()`, on the path where a frame completes.
        const info = this.renderDegradation.note(this.consecutiveDegradedFrames, detail, origin);
        if (!info) return;
        console.warn(
            `[Renderer] ${info.consecutiveDegradedFrames} consecutive frames degraded without one completing — the viewport is not updating.`,
        );
        for (const listener of this.persistentDegradationListeners) {
            try {
                listener(info);
            } catch (e) {
                console.error('[Renderer] onPersistentRenderDegradation listener threw:', e);
            }
        }
    }

    /**
     * Replace all loaded point clouds with `assets`.
     *
     * Phase 0 entry point — single-chunk inline assets from IFCx
     * (`pcd::base64`, `points::array`, `points::base64`). Future phases
     * accept streaming sources via a different overload.
     */
    setPointClouds(assets: ReadonlyArray<PointCloudAsset>): void {
        if (!this.pointCloudRenderer) {
            throw new Error('Renderer not initialized. Call init() first.');
        }
        this.pointCloudRenderer.setAssets(assets);
        // Replace, not append — bounds may have shrunk (e.g. an IFCx
        // reload with a smaller scan). `expandForPointClouds`
        // alone only grows; recompute from scratch to keep
        // fit-to-view + section-plane sliders accurate.
        this.modelBoundsTracker.recompute();
        this.camera.setSceneBounds(this.modelBounds);
        this.requestRender();
    }

    /** Append additional point clouds without clearing existing ones. */
    addPointClouds(assets: ReadonlyArray<PointCloudAsset>): void {
        if (!this.pointCloudRenderer) {
            throw new Error('Renderer not initialized. Call init() first.');
        }
        for (const asset of assets) {
            this.pointCloudRenderer.addAsset(asset);
        }
        this.modelBoundsTracker.expandForPointClouds();
        this.camera.setSceneBounds(this.modelBounds);
        this.requestRender();
    }

    /** Total number of point cloud assets currently uploaded. */
    getPointCloudAssetCount(): number {
        return this.pointCloudRenderer?.getNodeCount() ?? 0;
    }

    /** Total number of points across all point cloud assets. */
    getPointCloudPointCount(): number {
        return this.pointCloudRenderer?.getPointCount() ?? 0;
    }

    /** Drop all point cloud GPU resources. */
    clearPointClouds(): void {
        this.pointCloudRenderer?.clear();
        this.modelBoundsTracker.recompute();
        this.camera.setSceneBounds(this.modelBounds);
        this.requestRender();
    }

    /**
     * Streaming entry: open an empty asset that will receive chunks via
     * `appendPointCloudChunk`. Call `endPointCloudStream` when no more
     * chunks will arrive (currently a no-op but kept for symmetry).
     */
    beginPointCloudStream(meta: { expressId: number; ifcType?: string; modelIndex?: number }): import('./pointcloud/point-cloud-renderer.js').PointCloudAssetHandle {
        if (!this.pointCloudRenderer) {
            throw new Error('Renderer not initialized. Call init() first.');
        }
        return this.pointCloudRenderer.beginAsset(meta);
    }

    appendPointCloudChunk(
        handle: import('./pointcloud/point-cloud-renderer.js').PointCloudAssetHandle,
        chunk: import('./pointcloud/point-cloud-node.js').PointCloudChunkInput,
    ): void {
        if (!this.pointCloudRenderer) return;
        this.pointCloudRenderer.appendChunk(handle, chunk);
        this.modelBoundsTracker.expandForPointClouds();
        this.camera.setSceneBounds(this.modelBounds);
        this.requestRender();
    }

    endPointCloudStream(handle: import('./pointcloud/point-cloud-renderer.js').PointCloudAssetHandle): void {
        this.pointCloudRenderer?.endAsset(handle);
        this.requestRender();
    }

    removePointCloudAsset(handle: import('./pointcloud/point-cloud-renderer.js').PointCloudAssetHandle): void {
        this.pointCloudRenderer?.removeAsset(handle);
        // Bounds may have shrunk — recompute from scratch so fit-to-view
        // and section-plane sliders see fresh extents.
        this.modelBoundsTracker.recompute();
        this.camera.setSceneBounds(this.modelBounds);
        this.requestRender();
    }

    /**
     * Reassign a streamed point-cloud's expressId after upload. Use
     * this when the federation registry assigns a new model offset and
     * the renderer needs to emit the post-offset globalId in picking
     * outputs. The change takes effect on the next render — no GPU
     * buffer rewrite needed.
     */
    relabelPointCloudAsset(
        handle: import('./pointcloud/point-cloud-renderer.js').PointCloudAssetHandle,
        newExpressId: number,
    ): void {
        this.pointCloudRenderer?.relabelAsset(handle, newExpressId);
        this.requestRender();
    }

    /** Aggregate bounds across all batched + individual meshes. Returns
     *  null if the scene has no mesh geometry. */
    private computeMeshBounds(): { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null {
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        let any = false;
        for (const batch of this.scene.getBatchedMeshes()) {
            if (!batch.bounds) continue;
            any = true;
            if (batch.bounds.min[0] < minX) minX = batch.bounds.min[0];
            if (batch.bounds.min[1] < minY) minY = batch.bounds.min[1];
            if (batch.bounds.min[2] < minZ) minZ = batch.bounds.min[2];
            if (batch.bounds.max[0] > maxX) maxX = batch.bounds.max[0];
            if (batch.bounds.max[1] > maxY) maxY = batch.bounds.max[1];
            if (batch.bounds.max[2] > maxZ) maxZ = batch.bounds.max[2];
        }
        if (!any) return null;
        return { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } };
    }

    /** Apply rendering options (color mode, fixed override, point size). */
    setPointCloudOptions(opts: import('./pointcloud/point-cloud-renderer.js').PointCloudRenderOptions): void {
        this.pointCloudRenderer?.setOptions(opts);
        this.requestRender();
    }

    /**
     * Set (or clear, with `null`) a streamed point-cloud asset's per-vertex
     * GPU model matrix (column-major, 16 floats) — issue #1804's
     * `IfcMapConversion` alignment toggle. Cheap: takes effect on the next
     * frame's uniform write, no GPU buffer rewrite.
     */
    setPointCloudTransform(
        handle: import('./pointcloud/point-cloud-renderer.js').PointCloudAssetHandle,
        matrix: Float32Array | null,
    ): void {
        this.pointCloudRenderer?.setAssetTransform(handle, matrix);
        // The asset's world-space extents just moved: re-fold the (now
        // matrix-aware) point-cloud bounds into the scene bounds and push
        // them to the camera (matching every other bounds-mutating
        // point-cloud method) so framing / zoom-to-fit targets where the
        // points actually render.
        this.modelBoundsTracker.recompute();
        this.camera.setSceneBounds(this.modelBounds);
        this.requestRender();
    }

    /**
     * Compute BIM ↔ scan deviation for every loaded point cloud asset.
     *
     * Walks every triangle in the scene (individual + batched meshes,
     * regardless of which IFC ingest path produced them — STEP, IFCx,
     * GLB, or federated combinations), builds a per-triangle BVH on
     * the GPU, then runs a closest-point compute pass per chunk that
     * writes signed distance into each chunk's deviation buffer.
     *
     * Returns metadata so the UI can populate a histogram + auto-range:
     * the per-asset point count, the suggested ±range from the 95th
     * percentile, and the bbox the BVH was built from.
     *
     * Idempotent: re-running with the same mesh set reuses the GPU
     * BVH (the BVH build dominates wall time on big BIMs). Pass
     * `forceRebuild: true` to invalidate.
     */
    async computeDeviations(opts: {
        /** Clip range applied during compute. 0 → no clip. Default 1m. */
        maxRange?: number;
        forceRebuild?: boolean;
    } = {}): Promise<{
        bvhTriangles: number;
        bvhNodes: number;
        chunksProcessed: number;
        pointsProcessed: number;
        bounds: { min: [number, number, number]; max: [number, number, number] } | null;
        suggestedHalfRange: number;
    }> {
        if (!this.deviationPipeline || !this.pointCloudRenderer) {
            throw new Error('Renderer not initialised — call init() first.');
        }
        const meshes = this.collectAllSceneMeshes();
        // Fingerprint folds in per-mesh expressId / modelIndex /
        // positions length / triangle count, so two distinct meshes
        // that happen to share an aggregate position-length total
        // can't alias each other. A federation reload that swaps one
        // model for another with the same total triangle count would
        // otherwise reuse the previous BVH and report wrong distances.
        const fingerprint = computeBvhFingerprint(meshes);
        if (opts.forceRebuild || fingerprint !== this.deviationBvhFingerprint) {
            const bvh = buildTriangleBVH(meshes);
            this.deviationPipeline.uploadBvh(bvh);
            this.deviationBvhFingerprint = fingerprint;
        }
        const stats = this.deviationPipeline.getBvhStats();
        const maxRange = opts.maxRange ?? 1.0;

        // Encode every chunk into a single command submit so the GPU
        // can pipeline the dispatches without a CPU round-trip per
        // chunk. Histogram readback is a follow-up — for v1 we emit
        // the deviation buffers and let the splat shader visualise.
        const encoder = this.device.getDevice().createCommandEncoder({ label: 'pointcloud-deviation' });
        let chunksProcessed = 0;
        let pointsProcessed = 0;
        const nodes = this.pointCloudRenderer.getInternalNodes();
        for (const node of nodes) {
            for (const chunk of node.chunks) {
                const ok = this.deviationPipeline.dispatch(encoder, {
                    positionsBuffer: chunk.vertexBuffer,
                    deviationsBuffer: chunk.deviationBuffer,
                    pointCount: chunk.pointCount,
                    maxRange,
                    // #1804: chunk positions are stored in the asset's
                    // decode-shifted local frame when IfcMapConversion
                    // alignment is active; the BVH triangles are world
                    // space, so the compute pass must apply the same
                    // per-asset matrix the splat shader renders with.
                    model: node.model,
                });
                if (ok) {
                    chunksProcessed++;
                    pointsProcessed += chunk.pointCount;
                }
            }
        }
        this.device.getDevice().queue.submit([encoder.finish()]);
        // Wait until the GPU finishes the dispatches before resolving.
        // Otherwise the caller's "compute done" callback fires before
        // the deviation buffers are actually populated.
        await this.device.getDevice().queue.onSubmittedWorkDone();
        // The GPU is done reading each chunk's params uniform — free them.
        this.deviationPipeline.releaseTransientParams();
        this.requestRender();

        // Suggest a default half-range = max(0.01m, max-extent / 1000).
        // Tighter than the maxRange clip; gives the user a reasonable
        // starting slider position without a histogram readback.
        const bb = stats.bounds;
        const suggestedHalfRange = bb
            ? Math.max(0.01, Math.max(
                bb.max[0] - bb.min[0],
                bb.max[1] - bb.min[1],
                bb.max[2] - bb.min[2],
              ) / 1000)
            : 0.05;

        return {
            bvhTriangles: stats.triangleCount,
            bvhNodes: stats.nodeCount,
            chunksProcessed,
            pointsProcessed,
            bounds: stats.bounds,
            suggestedHalfRange,
        };
    }

    /**
     * Aggregate every triangle source the scene exposes — individual
     * meshes (created on demand by picking / highlights) AND batched
     * meshes (the streaming geometry path's compact GPU buffers).
     * Both formats arrive as `MeshData`; the BVH builder doesn't care
     * which source they came from.
     */
    private collectAllSceneMeshes(): import('@ifc-lite/geometry').MeshData[] {
        // The Scene keeps every CPU-side MeshData regardless of which
        // ingest path produced it (STEP / IFCx / GLB). One iteration
        // covers individual + batched + multi-piece + multi-model.
        // `forEachMeshData` deduplicates by identity so a colour-merged
        // batch is only added once even if it's indexed under multiple
        // contributor expressIds.
        const out: import('@ifc-lite/geometry').MeshData[] = [];
        this.scene.forEachMeshData((md) => {
            if (md.positions && md.positions.length > 0) out.push(md);
        });
        return out;
    }

    /**
     * Toggle Eye-Dome Lighting and tune its strength.
     *
     * EDL adds depth perception to point clouds (and meshes) via screen-
     * space depth gradient — silhouette pixels get a soft black halo.
     * Cheap: ~9 texture taps per pixel. Only runs when point clouds are
     * loaded.
     */
    setEdlOptions(opts: { enabled?: boolean; strength?: number; radiusPx?: number; highQuality?: boolean }): void {
        if (opts.enabled !== undefined) this.edlOptions.enabled = opts.enabled;
        if (opts.strength !== undefined) this.edlOptions.strength = Math.max(0, Math.min(3, opts.strength));
        if (opts.radiusPx !== undefined) this.edlOptions.radiusPx = Math.max(1, Math.min(4, opts.radiusPx));
        if (opts.highQuality !== undefined) this.edlOptions.highQuality = opts.highQuality;
        this.requestRender();
    }

    /**
     * Load geometry from GeometryResult or MeshData array
     * This is the main entry point for loading IFC geometry into the renderer
     *
     * @param geometry - Either a GeometryResult from geometry.process() or an array of MeshData
     */
    loadGeometry(geometry: import('@ifc-lite/geometry').GeometryResult | import('@ifc-lite/geometry').MeshData[]): void {
        if (!this.device.isInitialized() || !this.pipeline) {
            throw new Error('Renderer not initialized. Call init() first.');
        }

        const meshes = Array.isArray(geometry) ? geometry : geometry.meshes;

        if (meshes.length === 0) {
            console.warn('[Renderer] loadGeometry called with empty mesh array');
            return;
        }

        // Use batched rendering for optimal performance
        const device = this.device.getDevice();
        this.scene.appendToBatches(meshes, device, this.pipeline, false);

        // Calculate and store model bounds for fitToView
        this.modelBoundsTracker.updateFromMeshes(meshes);

        console.log(`[Renderer] Loaded ${meshes.length} meshes`);

        // Update camera scene bounds for tight orthographic near/far planes
        this.camera.setSceneBounds(this.modelBounds);
    }

    /**
     * Add multiple meshes to the scene (convenience method for streaming)
     *
     * @param meshes - Array of MeshData to add
     * @param isStreaming - If true, throttles batch rebuilding for better streaming performance
     */
    addMeshes(meshes: import('@ifc-lite/geometry').MeshData[], isStreaming: boolean = false): void {
        if (!this.device.isInitialized() || !this.pipeline) {
            throw new Error('Renderer not initialized. Call init() first.');
        }

        if (meshes.length === 0) return;

        const device = this.device.getDevice();
        this.scene.appendToBatches(meshes, device, this.pipeline, isStreaming);

        // Update model bounds incrementally
        this.modelBoundsTracker.updateFromMeshes(meshes);

        // Update camera scene bounds for tight orthographic near/far planes
        this.camera.setSceneBounds(this.modelBounds);
    }

    /**
     * Fit camera to view all loaded geometry
     */
    fitToView(): void {
        if (!this.modelBounds) {
            console.warn('[Renderer] fitToView called but no geometry loaded');
            return;
        }

        const { min, max } = this.modelBounds;

        // Calculate center and size
        const center = {
            x: (min.x + max.x) / 2,
            y: (min.y + max.y) / 2,
            z: (min.z + max.z) / 2
        };

        const size = Math.max(
            max.x - min.x,
            max.y - min.y,
            max.z - min.z
        );

        // Position camera to see entire model
        const distance = size * 1.5;
        this.camera.setPosition(
            center.x + distance * 0.5,
            center.y + distance * 0.5,
            center.z + distance
        );
        this.camera.setTarget(center.x, center.y, center.z);
    }

    /**
     * Add mesh to scene with per-mesh GPU resources for unique colors
     */
    addMesh(mesh: Mesh): void {
        if (!this.pipeline) return;

        // Create per-mesh uniform buffer and bind group if not already created
        if (!mesh.uniformBuffer && this.device.isInitialized()) {
            const device = this.device.getDevice();

            // Create uniform buffer for this mesh
            mesh.uniformBuffer = device.createBuffer({
                size: this.pipeline.getUniformBufferSize(),
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });

            // Create bind group for this mesh
            mesh.bindGroup = device.createBindGroup({
                layout: this.pipeline.getBindGroupLayout(),
                entries: [
                    {
                        binding: 0,
                        resource: { buffer: mesh.uniformBuffer },
                    },
                ],
            });
        }

        this.scene.addMesh(mesh);
    }

    /**
     * Ensure all meshes have GPU resources (call after adding meshes if pipeline wasn't ready)
     */
    ensureMeshResources(): void {
        if (!this.pipeline || !this.device.isInitialized()) return;

        const device = this.device.getDevice();
        for (const mesh of this.scene.getMeshes()) {
            if (!mesh.uniformBuffer) {
                mesh.uniformBuffer = device.createBuffer({
                    size: this.pipeline.getUniformBufferSize(),
                    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
                });
                mesh.bindGroup = device.createBindGroup({
                    layout: this.pipeline.getBindGroupLayout(),
                    entries: [{
                        binding: 0,
                        resource: { buffer: mesh.uniformBuffer },
                    }],
                });
            }
        }
    }

    /**
     * Get model bounds (used for section planes, fitToView, etc.)
     */
    getModelBounds(): { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null {
        return this.modelBounds;
    }

    /**
     * Set model bounds (used when computing bounds from batches)
     */
    setModelBounds(bounds: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }): void {
        this.modelBoundsTracker.set(bounds);
    }

    /**
     * Create a GPU Mesh from MeshData (lazy creation for selection highlighting)
     * This is called on-demand when a mesh is selected, avoiding 2x buffer creation during streaming
     */
    createMeshFromData(meshData: MeshData): void {
        if (!this.device.isInitialized()) return;

        const device = this.device.getDevice();
        const vertexCount = meshData.positions.length / 3;
        const interleavedRaw = new ArrayBuffer(vertexCount * 7 * 4);
        const interleaved = new Float32Array(interleavedRaw);
        const interleavedU32 = new Uint32Array(interleavedRaw);

        // Build this individual mesh (selection highlight + GPU object-id picker)
        // in ABSOLUTE world space so it renders with an identity model matrix.
        // CRITICAL: replicate the BATCH's exact two-step f32 path so the highlight
        // is bit-coincident with its source surface (no z-fight, no depth bias):
        //   batch stores  s = f32(local + (origin - sharedOrigin))   [merge]
        //   batch shader  world = f32(f32(sharedOrigin) + s)         [draw]
        // We compute the same `world` here. When there's no shared origin yet
        // (legacy / pre-batch), fall back to a plain f64 fold (local + origin).
        const o = meshData.origin;
        const so = this.scene.getSharedFrameOrigin();
        const ox = o ? o[0] : 0, oy = o ? o[1] : 0, oz = o ? o[2] : 0;
        const fr = Math.fround;
        const sox = so ? fr(so[0]) : null, soy = so ? fr(so[1]) : 0, soz = so ? fr(so[2]) : 0;
        const dx = so ? (ox - so[0]) : ox, dy = so ? (oy - so[1]) : oy, dz = so ? (oz - so[2]) : oz;
        // Quantized batches (issue #1682 phase 6) render lattice-snapped
        // positions: the shader's quantMin + q*step is exactly the lattice
        // node nearest the batch's stored f32 rel coordinate. Reproduce it by
        // snapping the SAME rel coordinate here (round(s*1024)/1024 in f64
        // yields the identical exact-f32 lattice value — see quantize.ts), so
        // the highlight/picker mesh stays BIT-coincident with its quantized
        // source surface, exactly as the two-step fold above achieves for the
        // f32 path. Meshes whose batch fell back to f32 must not snap.
        const snap = this.scene.isMeshQuantized(meshData)
            ? (v: number) => Math.round(v * 1024) / 1024
            : (v: number) => v;
        const p = meshData.positions;
        for (let i = 0; i < vertexCount; i++) {
            const base = i * 7;
            const posBase = i * 3;
            interleaved[base] = so ? fr((sox as number) + snap(fr(p[posBase] + dx))) : snap(p[posBase] + dx);
            interleaved[base + 1] = so ? fr(soy + snap(fr(p[posBase + 1] + dy))) : snap(p[posBase + 1] + dy);
            interleaved[base + 2] = so ? fr(soz + snap(fr(p[posBase + 2] + dz))) : snap(p[posBase + 2] + dz);
            const hasNormals = meshData.normals.length > 0;
            interleaved[base + 3] = hasNormals ? meshData.normals[posBase] : 0;
            interleaved[base + 4] = hasNormals ? meshData.normals[posBase + 1] : 0;
            interleaved[base + 5] = hasNormals ? meshData.normals[posBase + 2] : 0;
            let encodedId = meshData.expressId >>> 0;
            if (encodedId > MAX_ENCODED_ENTITY_ID) {
                if (!warnedEntityIdRange) {
                    warnedEntityIdRange = true;
                    console.warn('[Renderer] expressId exceeds 24-bit seam-ID encoding range; seam lines may collide.');
                }
                encodedId = encodedId & MAX_ENCODED_ENTITY_ID;
            }
            // Stamp the SAME high-byte material-colour salt as the batch path
            // (mergeGeometry) so this individual/selection mesh computes the
            // identical depth nudge as its source batch — otherwise the highlight
            // (selection pipeline, reverse-Z 'greater-equal') would z-fight or drop
            // out against the salted base depth. Low 24 bits stay the picking id.
            interleavedU32[base + 6] = packEntityLane(encodedId, colorSaltByte(meshData.color));
        }

        const vertexBuffer = device.createBuffer({
            size: interleaved.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(vertexBuffer, 0, interleaved);

        const indexBuffer = device.createBuffer({
            size: meshData.indices.byteLength,
            usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(indexBuffer, 0, meshData.indices);

        // Add to scene with identity transform (positions already in world space).
        // Flagged `hydrated` so it can be freed when its entity leaves the
        // selection — these duplicate geometry already drawn by a batch and would
        // otherwise accumulate + double-draw (see Scene.disposeHydratedMeshesExcept).
        this.scene.addMesh({
            expressId: meshData.expressId,
            modelIndex: meshData.modelIndex,  // Preserve modelIndex for multi-model selection
            vertexBuffer,
            indexBuffer,
            indexCount: meshData.indices.length,
            transform: MathUtils.identity(),
            color: meshData.color,
            hydrated: true,
        });
    }

    /**
     * On a selection change, free the hydrated (pick/selection-highlight)
     * individual meshes whose entity is no longer selected. These duplicate
     * geometry already drawn by a batch; without this they accumulate in
     * scene.meshes (VRAM grows with selection history) and — for transparent
     * entities — re-draw every frame on top of their still-drawn batch copy
     * (double alpha-blend darkens glass). Currently-selected entities keep their
     * hydrated meshes so the highlight pass doesn't rebuild them each change.
     * No-op when the selection set is unchanged to avoid per-frame buffer churn.
     * Selection identity is the (modelIndex, expressId) PAIR: federated models
     * can share express ids, so re-selecting the same id in a different model
     * must still free the previous model's hydrated mesh (it would otherwise
     * stay resident and keep drawing unhighlighted).
     */
    private syncHydratedSelectionMeshes(
        selected: ReadonlySet<number>,
        selectedModelIndex: number | undefined,
    ): void {
        const prev = this._prevHydratedSelection;
        let changed = selected.size !== prev.size
            || selectedModelIndex !== this._prevHydratedSelectionModelIndex;
        if (!changed) {
            for (const id of selected) {
                if (!prev.has(id)) { changed = true; break; }
            }
        }
        if (!changed) return;
        this._prevHydratedSelection = new Set(selected);
        this._prevHydratedSelectionModelIndex = selectedModelIndex;
        this.scene.disposeHydratedMeshesExcept(selected, selectedModelIndex);
    }

    /**
     * Pop the frame's validation error scope, recording any captured validation
     * error into the device diagnostics (getDiagnostics().gpuErrors). The pop
     * itself REJECTS when the GPU device is lost while the scope is pending —
     * often the only evidence of the loss — so the rejection is logged
     * (throttled) and the context invalidated, never swallowed silently. Used
     * by every render() exit path that pushed a scope, so push/pop stay
     * balanced even on skipped or throwing frames.
     */
    private drainErrorScope(device: GPUDevice): void {
        device.popErrorScope().then((error) => {
            if (error) {
                const msg = error.message || String(error);
                console.error('[WebGPU] Validation error in render pass:', msg);
                this.device._lastUncapturedError = `VALIDATION: ${msg}`;
                this.device._uncapturedErrorCount++;
            }
        }).catch((error: unknown) => {
            // popErrorScope() rejects (e.g. "Instance dropped in popErrorScope")
            // when the GPU device is lost while the scope is still pending. This
            // escapes the surrounding synchronous try/catch and would otherwise
            // surface as an unhandled rejection. Treat it like any other device
            // loss: invalidate the context so it reconfigures next frame.
            this.device.invalidateContext();
            const now = performance.now();
            if (now - this.lastRenderErrorTime > this.RENDER_ERROR_THROTTLE_MS) {
                this.lastRenderErrorTime = now;
                console.warn('[WebGPU] popErrorScope rejected (device likely lost):', error);
            }
        });
    }

    /**
     * Render frame
     */
    /** Get diagnostic info for mobile debugging */
    getDiagnostics(): {
        calls: number; skips: number; errors: number; lastError: string;
        batches: number; meshes: number; contextOk: boolean;
        gpuErrors: number; lastGpuError: string;
        camPos: string; camTgt: string; bounds: string;
    } {
        const pos = this.camera.getPosition();
        const tgt = this.camera.getTarget();
        const b = this.modelBounds;
        return {
            calls: this._renderCallCount,
            skips: this._renderSkipCount,
            errors: this._renderErrorCount,
            lastError: this._lastRenderError,
            batches: this.scene.getBatchedMeshes().length,
            meshes: this.scene.getMeshes().length,
            contextOk: this.device.isInitialized(),
            gpuErrors: this.device._uncapturedErrorCount,
            lastGpuError: this.device._lastUncapturedError ?? '',
            camPos: `${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)}`,
            camTgt: `${tgt.x.toFixed(1)},${tgt.y.toFixed(1)},${tgt.z.toFixed(1)}`,
            bounds: b ? `${b.min.x.toFixed(0)}..${b.max.x.toFixed(0)} ${b.min.y.toFixed(0)}..${b.max.y.toFixed(0)} ${b.min.z.toFixed(0)}..${b.max.z.toFixed(0)}` : 'none',
        };
    }

    /**
     * Statistics of the last COMPLETED render() call (draw calls issued,
     * batches drawn / frustum-culled / contribution-culled), or null before
     * the first frame. Pair with `getScene().getResidentGpuBytes()` for the
     * load-complete telemetry snapshot (issue #1682 observability).
     */
    getFrameStats(): FrameStats | null {
        return this._lastFrameStats;
    }

    /**
     * Probe the quantized pipeline variants and, when all exist, enable
     * 12-byte quantized batch vertices (issue #1682 phase 6). Returns
     * whether quantization is active — on failure (e.g. a fragile backend
     * rejecting pipeline creation) batches stay on the f32 path.
     */
    async enableQuantizedBatches(): Promise<boolean> {
        if (!this.pipeline) return false;
        const ok = await this.pipeline.ensureQuantizedPipelines();
        if (ok) this.scene.setQuantizedBatches(true);
        return ok;
    }

    /**
     * Draw one frame.
     *
     * Never throws, so callers never need to guard this call to keep their
     * animation loop alive.
     *
     * What a throw MEANS depends on its type (`isDeviceLossThrow`), and since
     * issue #2417 that holds for the WHOLE frame — both this catch and the
     * encode region's own, which share `containFrameThrow`:
     *  - a `DOMException` is the device reporting its own death synchronously
     *    (Safari 26.5, issue #2229). It latches the same `deviceLost` state the
     *    async `device.lost` promise would: later frames become quiet skips and
     *    `onDeviceLost` listeners fire exactly once.
     *  - anything else (a `RangeError` from a buffer the host cannot allocate,
     *    say) costs only this frame: the swap-chain config is invalidated so
     *    the next frame reconfigures, a frame is re-requested within a bounded
     *    budget, the failure is counted in `getDiagnostics()`, and rendering
     *    carries on. Once enough such frames have degraded without recovering,
     *    `onPersistentRenderDegradation` fires once.
     *
     * SCOPE: `renderFrame()` has two try/catch regions — this outer one (canvas
     * resize, context setup, evicted-batch restore) and an inner one opened
     * after the swap-chain texture is acquired, covering encoder work through
     * `submit`. Until #2417 only the outer one discriminated, so a device that
     * died after `getCurrentTexture()` succeeded degraded quietly forever with
     * no latch and no toast. Both now run the same policy; the encode catch
     * additionally balances the frame's validation error scope before doing so.
     */
    render(options: RenderOptions = {}): void {
        this._renderCallCount++;
        // A lost device leaves every pipeline/buffer dead; rendering would only
        // emit a stream of validation errors. Stay quiet until re-init.
        if (this.deviceLost) {
            this._renderSkipCount++;
            return;
        }
        try {
            this.frameContainedThrow = false;
            this.renderFrame(options);
            // Only a frame that actually got through resets the run. A frame
            // the ENCODE catch contained returns here normally (that catch is
            // inside renderFrame), so "did not throw" is not the same question
            // as "did not fail" — see `frameContainedThrow`.
            if (!this.frameContainedThrow) this.consecutiveDegradedFrames = 0;
        } catch (error) {
            // Safari (26.5) reports device loss SYNCHRONOUSLY: a call against a
            // dead device throws `InvalidStateError` instead of — or long
            // before — resolving `device.lost` (issue #2229). Without this
            // catch the throw escapes render(), the caller's rAF loop never
            // re-arms, and the viewer freezes for good with nothing on screen
            // and nothing subscribed to onDeviceLost ever told.
            //
            // Deliberately NOT rethrown either way: the frame is already lost,
            // and the established contract is "degrade" (see `pickPathAlive()`
            // and the rAF loop's own upload/residency guards), not "take the
            // host down with us".
            this._renderSkipCount++;
            this.containFrameThrow(error, 'frame');
        }
    }

    /**
     * The frame body. Throws on a synchronously-dead GPU device; `render()`
     * owns the containment. Private for that reason — call `render()`.
     */
    private renderFrame(options: RenderOptions): void {
        if (!this.device.isInitialized() || !this.pipeline) {
            this._renderSkipCount++;
            return;
        }

        // Validate canvas dimensions
        // Align width to 64 pixels for WebGPU texture row alignment (256 bytes / 4 bytes per pixel)
        // and clamp both axes to the GPU's max 2D texture dimension. Some hosts (e.g. tall iframes
        // on high-DPR displays) can produce canvas dimensions that exceed 8192 and would otherwise
        // make every depth/colour texture allocation a validation error.
        const rect = this.canvas.getBoundingClientRect();
        const maxDim = this.device.getMaxTextureDimension();
        const rawWidth = Math.max(1, Math.floor(rect.width));
        const widthAligned = Math.max(64, Math.floor(rawWidth / 64) * 64);
        const width = Math.min(widthAligned, Math.floor(maxDim / 64) * 64);
        const rawHeight = Math.max(1, Math.floor(rect.height));
        const height = Math.min(rawHeight, maxDim);

        // Skip rendering if canvas is too small
        if (width < 64 || height < 10) { this._renderSkipCount++; return; }

        // Update canvas pixel dimensions if needed
        const dimensionsChanged = this.canvas.width !== width || this.canvas.height !== height;
        if (dimensionsChanged) {
            this.canvas.width = width;
            this.canvas.height = height;
            this.camera.setAspect(width / height);
            // Force reconfigure when dimensions change
            this.device.configureContext();
            // Also resize the depth texture immediately
            this.pipeline.resize(width, height);
        }

        // Skip rendering if canvas is invalid
        if (this.canvas.width === 0 || this.canvas.height === 0) { this._renderSkipCount++; return; }

        // Ensure context is valid before rendering (handles HMR, focus changes, etc.)
        if (!this.device.ensureContext()) {
            this._renderSkipCount++;
            return; // Skip this frame, context will be ready next frame
        }

        const device = this.device.getDevice();
        const viewProj = this.camera.getViewProjMatrix().m;
        // Frame stats (issue #1682): geometry draw calls + per-frame cull
        // outcomes, snapshotted into _lastFrameStats before queue.submit.
        let frameDrawCalls = 0;
        let frameBatchesDrawn = 0;
        let frameBatchesFrustumCulled = 0;
        let frameBatchesContributionCulled = 0;
        let frameBatchesNotResident = 0;
        let frameBatchesAtLod1 = 0;
        let frameInstancedDrawn = 0;
        let frameInstancedFrustumCulled = 0;
        let frameInstancedContributionCulled = 0;
        // Residency ages are measured in RENDERED frames (idle never ages out).
        this.scene.beginResidencyFrame();
        // Capture renders restore evicted batches SYNCHRONOUSLY so isolation
        // snapshots are complete in this very frame (see RenderOptions doc).
        if (options.restoreEvictedForCapture && this.pipeline) {
            this.scene.restoreAllEvicted(device, this.pipeline);
        }
        const visualEnhancement = this.visualEnhancementResolver.resolve(options.visualEnhancement);
        // Post effects during interaction (orbit/pan/zoom) are governed
        // adaptively: they stay on while the interactive frame cadence holds
        // (the pass costs well under a ms on discrete/Apple GPUs at CSS
        // resolution) and degrade to the legacy effects-off behaviour only
        // on machines that measurably miss frames — integrated GPUs at large
        // canvases. See InteractionEffectsGovernor.
        const interacting = options.isInteracting === true;
        // Frames rendered while geometry is still streaming in carry upload
        // jank unrelated to steady-state cost — exclude them from the
        // governor's verdict so early navigation can't degrade a session.
        const timingUnstable = options.isStreaming === true || this.scene.hasQueuedMeshes();
        const effectsLive = this.interactionEffects.frame(
            interacting,
            performance.now(),
            timingUnstable,
            options.interactionFrameIntervalMs ?? 0,
        );
        // Edge contrast is NOT interaction-gated: its per-fragment work runs
        // unconditionally in the shader and the gated tail is a handful of
        // ALU ops, so disabling it bought nothing and only made the crease
        // darkening pop off/on around gestures (visible in ortho).
        const edgeEnabled = visualEnhancement.enabled && visualEnhancement.edgeContrast.enabled;
        const edgeIntensity = Math.min(3.0, Math.max(0.0, visualEnhancement.edgeContrast.intensity));
        const edgeEnabledU32 = edgeEnabled ? 1 : 0;
        const edgeIntensityMilliU32 = Math.round(edgeIntensity * 1000);
        const contactEnabled = effectsLive && visualEnhancement.enabled && visualEnhancement.contactShading.quality !== 'off';
        const separationEnabled = effectsLive && visualEnhancement.enabled
            && visualEnhancement.separationLines.enabled
            && visualEnhancement.separationLines.quality !== 'off';
        const needsObjectIdPass = contactEnabled || separationEnabled;

        // Check if visibility filtering is active
        const hasHiddenFilter = options.hiddenIds && options.hiddenIds.size > 0;
        const hasIsolatedFilter = options.isolatedIds !== null && options.isolatedIds !== undefined;
        const hasVisibilityFiltering = hasHiddenFilter || hasIsolatedFilter;

        // ─── Visibility / override epoch bookkeeping ────────────────────────
        // The tracker compares hide/isolate CONTENT against a snapshot, so both
        // in-place mutation of the caller's Set and a fresh identical Set per
        // frame behave correctly (see RenderOptions.hiddenIds). Bumping
        // `_visibilityVersion` invalidates the per-batch visibility cache; the
        // partial sub-batch cache additionally depends on colour-override
        // promotion, so its epoch bumps on either.
        const newVisibilityVersion = this._visibilityEpochs.update(options.hiddenIds, options.isolatedIds);
        const visibilityChanged = newVisibilityVersion !== this._visibilityVersion;
        this._visibilityVersion = newVisibilityVersion;
        const colorOverrideGen = this.scene.getColorOverrideGeneration();
        if (visibilityChanged || colorOverrideGen !== this._lastColorOverrideGen) {
            this._lastColorOverrideGen = colorOverrideGen;
            this._partialBatchEpoch++;
        }

        // When hide/isolate turns fully OFF (back to all-visible), release the
        // partial sub-batch clones built while filtering. They are excluded from
        // the GPU residency budget and are otherwise only freed on clear()/
        // finalize/evict — never here — so ~model-sized clone VRAM would stay
        // pinned until the next model reload. Any override-promotion sub-batches
        // dropped alongside are rebuilt on demand next frame (cache miss).
        if (this._lastHadVisibilityFiltering && !hasVisibilityFiltering) {
            this.scene.dropAllPartialCaches();
        }
        this._lastHadVisibilityFiltering = hasVisibilityFiltering;

        // Build the selected-id set once per frame so the X-Ray override paths
        // can keep highlighted entities at full alpha without per-site checks.
        const selectedId = options.selectedId;
        const selectedIds = options.selectedIds;
        const selectedModelIndex = options.selectedModelIndex;
        const selectedExpressIds = new Set<number>();
        if (selectedId !== undefined && selectedId !== null) {
            selectedExpressIds.add(selectedId);
        }
        if (selectedIds) {
            for (const id of selectedIds) {
                selectedExpressIds.add(id);
            }
        }
        const hasSelected = selectedExpressIds.size > 0;

        // Free hydrated (pick/selection) individual meshes whose entity is no
        // longer selected BEFORE we snapshot the mesh list, so stale glass
        // doesn't double-draw over its batch copy or accumulate until clear().
        // Only acts on a selection change (avoids per-frame buffer churn) and
        // never touches authored (non-hydrated) or batch geometry.
        this.syncHydratedSelectionMeshes(selectedExpressIds, selectedModelIndex);

        let meshes = this.scene.getMeshes();

        // Keep the GPU-instanced occurrences' per-instance selected flag in sync.
        // The Scene diff makes this a no-op (no writeBuffer) when the set is
        // unchanged, so calling it every frame is cheap; it no-ops entirely when
        // no instanced data is loaded. The flat path handles selection inline
        // below via `selectedExpressIds`.
        this.scene.setInstancedSelection(selectedExpressIds);
        // Mirror hide/isolate onto the instanced occurrences (the flat path filters
        // its mesh list by hiddenIds/isolatedIds below; the instanced pass can't, so
        // it carries a per-instance hidden flag the shader discards on). Diffed → a
        // no-op when visibility is unchanged.
        this.scene.setInstancedVisibility(options.hiddenIds, options.isolatedIds);

        // Per-frame alpha overrides for X-Ray mode. See RenderOptions.transparencyOverrides.
        // Snapshot the caller's map so mid-frame mutation can't desync classification
        // and uniform-write decisions for the same batch/mesh.
        const txOverridesSrc = options.transparencyOverrides;
        const hasTxMap = txOverridesSrc != null && txOverridesSrc.size > 0;
        const txOverrides = hasTxMap ? new Map(txOverridesSrc) : null;
        // X-Ray *context* mode: every non-selected mesh NOT in ghostExceptIds
        // fades to ghostAlpha. It feeds the same alpha-override machinery as
        // transparencyOverrides (explicit per-id entries win), so it routes
        // through the transparent pipeline with no extra call sites — and avoids
        // building a Map over every element just to fade "the rest".
        const ghostExceptIds = options.ghostExceptIds ?? null;
        const ghostAlpha = options.ghostAlpha ?? DEFAULT_GHOST_ALPHA;
        // X-Ray reaches the instanced pass too (#2606). Without this, ghosting
        // stopped at the flat geometry: on a model whose facade is instanced,
        // the user asked to fade the building and got a solid facade standing
        // in front of a ghosted interior.
        this.scene.setInstancedGhosting(ghostExceptIds, selectedExpressIds, ghostAlpha);
        const hasGhost = ghostExceptIds != null;
        const hasTxOverrides = hasTxMap || hasGhost;
        const alphaForMesh = (expressId: number, fallback: number): number => {
            if (!hasTxOverrides) return fallback;
            // Selected meshes are exempt — the highlight pass renders them last,
            // but exempting here also keeps mesh classification + uniform writes
            // consistent so a selected mesh never enters the transparent pipeline
            // because of its own override entry.
            if (hasSelected && selectedExpressIds.has(expressId)) return fallback;
            const a = txOverrides?.get(expressId);
            if (a !== undefined) return a;
            if (hasGhost && !ghostExceptIds!.has(expressId)) return ghostAlpha;
            return fallback;
        };
        // Cache resolved batch alpha for the frame: classification needs it
        // (opaque vs transparent routing) and renderBatch needs it for the
        // uniform write. Without the cache we'd walk batch.expressIds twice
        // per batch per frame, which becomes the dominant JS cost in X-Ray.
        const batchAlphaCache = hasTxOverrides
            ? new WeakMap<{ expressIds: number[]; color: [number, number, number, number] }, number>()
            : null;
        const alphaForBatch = (
            batch: { expressIds: number[]; color: [number, number, number, number] },
            fallback: number,
        ): number => {
            if (!hasTxOverrides) return fallback;
            const cached = batchAlphaCache!.get(batch);
            if (cached !== undefined) return cached;
            let minAlpha = Infinity;
            for (const eid of batch.expressIds) {
                // Selected ids never drag down a batch's alpha — the highlight
                // pass redraws them on top, but excluding here also means a
                // batch made entirely of selected entities stays opaque.
                if (hasSelected && selectedExpressIds.has(eid)) continue;
                const a = txOverrides?.get(eid);
                if (a !== undefined) {
                    if (a < minAlpha) minAlpha = a;
                } else if (hasGhost && !ghostExceptIds!.has(eid)) {
                    if (ghostAlpha < minAlpha) minAlpha = ghostAlpha;
                }
            }
            const resolved = minAlpha === Infinity ? fallback : minAlpha;
            batchAlphaCache!.set(batch, resolved);
            return resolved;
        };

        // Lens / Pset color overrides: when an entity has an override, force
        // its base draw through the opaque pipeline so it writes depth. The
        // overlay paint pass uses depthCompare 'equal' and otherwise silently
        // drops fragments belonging to entities whose default pipeline is
        // transparent (IfcSpace, IfcOpeningElement, glass, …). See issue #677.
        // Pure routing decision lives in overlay-routing.ts and is unit-tested
        // there.
        const colorOverrides = this.scene.getColorOverrides();

        // PERFORMANCE FIX: Use batch-level visibility filtering instead of creating individual meshes
        // Only create individual meshes for selected elements (for highlighting)
        // Batches are filtered at render time - fully visible batches render normally,
        // partially visible batches are skipped (their visible elements will be in other batches or individual meshes)

        // Ensure all existing meshes have GPU resources
        this.ensureMeshResources();


        // Frustum culling (if enabled and spatial index available)
        if (options.enableFrustumCulling && options.spatialIndex) {
            try {
                const frustum = FrustumUtils.fromViewProjMatrix(viewProj);
                const visibleIds = new Set(options.spatialIndex.queryFrustum(frustum));
                meshes = meshes.filter(mesh => visibleIds.has(mesh.expressId));
            } catch (error) {
                // Fallback: render all meshes if frustum culling fails
                console.warn('Frustum culling failed:', error);
            }
        }

        // Visibility filtering. Shares `isEntityVisible` with the instanced pass
        // and with the Cesium world view, which renders through its own glTF
        // pipeline and so cannot inherit this filter for free (#2578).
        if ((options.hiddenIds && options.hiddenIds.size > 0) || options.isolatedIds != null) {
            meshes = meshes.filter(mesh => isEntityVisible(mesh.expressId, options.hiddenIds, options.isolatedIds));
        }

        // Resize depth texture if needed
        if (this.pipeline.needsResize(this.canvas.width, this.canvas.height)) {
            this.pipeline.resize(this.canvas.width, this.canvas.height);
        }

        // Push a validation error scope to capture the EXACT error (for mobile debugging)
        // Only do this for the first few renders to avoid performance overhead.
        // Tracked with a flag (not just captureGpuError) so EVERY exit path below
        // pops it exactly once — an unpopped scope silently swallows all later
        // validation errors and blinds getDiagnostics().gpuErrors.
        const captureGpuError = this._renderCallCount <= 5;
        let errorScopePushed = false;
        if (captureGpuError) {
            device.pushErrorScope('validation');
            errorScopePushed = true;
        }

        // Get current texture safely - may return null if context needs reconfiguration
        const currentTexture = this.device.getCurrentTexture();
        if (!currentTexture) {
            // Balance the pushed scope before bailing so it doesn't leak into
            // the next frame; drainErrorScope logs a rejection (device loss)
            // instead of swallowing the evidence.
            if (errorScopePushed) {
                errorScopePushed = false;
                this.drainErrorScope(device);
            }
            return; // Skip this frame, context will be reconfigured next frame
        }

        try {
            const clearColor = options.clearColor
                ? (Array.isArray(options.clearColor)
                    ? { r: options.clearColor[0], g: options.clearColor[1], b: options.clearColor[2], a: options.clearColor[3] }
                    : options.clearColor)
                : { r: 0.1, g: 0.1, b: 0.1, a: 1 };

            const textureView = currentTexture.createView();
            const objectIdView = this.pipeline.getObjectIdTextureView();

            // Separate meshes into opaque and transparent
            const opaqueMeshes: typeof meshes = [];
            const transparentMeshes: typeof meshes = [];

            for (const mesh of meshes) {
                const alpha = alphaForMesh(mesh.expressId, mesh.color[3]);
                const transparency = mesh.material?.transparency ?? 0.0;
                const isTransparent = shouldRouteMeshTransparent(
                    alpha,
                    transparency,
                    mesh.expressId,
                    colorOverrides,
                );

                if (isTransparent) {
                    transparentMeshes.push(mesh);
                } else {
                    opaqueMeshes.push(mesh);
                }
            }

            // Sort transparent meshes back-to-front for proper blending
            if (transparentMeshes.length > 0) {
                transparentMeshes.sort((a, b) => {
                    return b.expressId - a.expressId; // Back to front (simplified)
                });
            }

            // Write uniform data to each mesh's buffer BEFORE recording commands
            // This ensures each mesh has its own color data
            const allMeshes = [...opaqueMeshes, ...transparentMeshes];

            // This frame's clip plane and the bounds the section slider is
            // expressed in — resolved in render-section-plane.ts, which owns
            // the bounds aggregation, the terrain-clip and explicit-plane
            // branches, and the one-shot diagnostic log (issue #2425).
            const sectionFrame = resolveSectionPlaneFrame({
                options,
                batchedMeshes: this.scene.getBatchedMeshes(),
                meshes,
                pointCloudBounds: this.pointCloudRenderer?.getBounds() ?? null,
                logSectionBounds: !this._loggedSectionBounds,
                spendLogLatch: () => { this._loggedSectionBounds = true; },
            });
            const sectionPlaneData = sectionFrame.sectionPlaneData;
            if (sectionFrame.bounds) {
                // Store bounds for section plane visual and camera near/far.
                // Two wrappers over the same min/max, exactly as before the
                // extraction — the renderer's copy is replaced wholesale by the
                // bounds helpers, the camera's is not.
                const { min: boundsMin, max: boundsMax } = sectionFrame.bounds;
                this.setModelBounds({ min: boundsMin, max: boundsMax });
                this.camera.setSceneBounds({ min: boundsMin, max: boundsMax });
            }

            // Stash what we actually clipped this frame so the GPU picker mirrors
            // it (section/crop-clipped geometry must be unpickable, not just hidden).
            // `flipped` matches how the mesh flags pack it below. terrainClipY feeds
            // sectionPlaneData too, so it's covered without special-casing.
            // Snapshot (don't alias the caller's arrays/object) so an in-place
            // mutation after render() can't make pick() mirror a different cut.
            this._activePickSection = sectionPlaneData?.enabled
                ? {
                    normal: [...sectionPlaneData.normal] as [number, number, number],
                    distance: sectionPlaneData.distance,
                    flipped: !!options.sectionPlane?.flipped,
                }
                : null;
            this._activePickClipBox = options.clipBox?.enabled
                ? {
                    enabled: true,
                    min: [...options.clipBox.min] as [number, number, number],
                    max: [...options.clipBox.max] as [number, number, number],
                }
                : null;

            // Reuse pooled scratch buffer for per-mesh uniform writes
            const meshBuf = this.uniformScratch;
            const meshFlags = this.uniformScratchU32;
            for (const mesh of allMeshes) {
                if (mesh.uniformBuffer) {
                    meshBuf.set(viewProj, 0);
                    meshBuf.set(mesh.transform.m, 16);

                    // Check if mesh is selected (single or multi-selection)
                    // For multi-model support: also check modelIndex if provided
                    const expressIdMatch = mesh.expressId === selectedId;
                    const modelIndexMatch = selectedModelIndex === undefined || mesh.modelIndex === selectedModelIndex;
                    const isSelected = (selectedId !== undefined && selectedId !== null && expressIdMatch && modelIndexMatch)
                        || (selectedIds !== undefined && selectedIds.has(mesh.expressId));

                    meshBuf[32] = mesh.color[0];
                    meshBuf[33] = mesh.color[1];
                    meshBuf[34] = mesh.color[2];
                    // Selected meshes always keep their own alpha so highlights stay opaque
                    meshBuf[35] = isSelected ? mesh.color[3] : alphaForMesh(mesh.expressId, mesh.color[3]);
                    meshBuf[36] = mesh.material?.metallic ?? 0.0;
                    meshBuf[37] = mesh.material?.roughness ?? 0.6;
                    meshBuf[38] = 0; meshBuf[39] = 0;

                    // Section plane data (offset 40-43)
                    if (sectionPlaneData) {
                        meshBuf[40] = sectionPlaneData.normal[0];
                        meshBuf[41] = sectionPlaneData.normal[1];
                        meshBuf[42] = sectionPlaneData.normal[2];
                        meshBuf[43] = sectionPlaneData.distance;
                    } else {
                        meshBuf[40] = 0; meshBuf[41] = 0; meshBuf[42] = 0; meshBuf[43] = 0;
                    }

                    // Clip box (offset 48-55: min.xyz + pad, max.xyz + pad) → enable bit
                    const clipBit = packClipBox(options.clipBox, meshBuf, 48);

                    // Flags (offset 44-47 as u32)
                    // flags.y packs: bit 0 = sectionEnabled, bit 1 = flipped, bit 2 = clipBoxEnabled
                    meshFlags[0] = isSelected ? 1 : 0;
                    meshFlags[1] =
                        (sectionPlaneData?.enabled ? 1 : 0) |
                        (options.sectionPlane?.flipped ? 2 : 0) |
                        clipBit;
                    meshFlags[2] = edgeEnabledU32;
                    meshFlags[3] = edgeIntensityMilliU32;

                    device.queue.writeBuffer(mesh.uniformBuffer, 0, meshBuf);
                }
            }

            // Now record draw commands
            const encoder = device.createCommandEncoder();

            // Set up MSAA rendering if enabled
            const msaaView = this.pipeline.getMultisampleTextureView();
            const useMSAA = msaaView !== null && this.pipeline.getSampleCount() > 1;

            // Build color attachments — skip objectId in single-target mode
            const colorAttachments: GPURenderPassColorAttachment[] = [
                {
                    // If MSAA enabled: render to multisample texture, resolve to swap chain
                    // If MSAA disabled: render directly to swap chain
                    view: useMSAA ? msaaView : textureView,
                    resolveTarget: useMSAA ? textureView : undefined,
                    loadOp: 'clear' as const,
                    clearValue: clearColor,
                    storeOp: (useMSAA ? 'discard' : 'store') as GPUStoreOp,
                },
            ];
            colorAttachments.push({
                view: objectIdView,
                loadOp: 'clear' as const,
                clearValue: { r: 0, g: 0, b: 0, a: 0 },
                storeOp: (needsObjectIdPass ? 'store' : 'discard') as GPUStoreOp,
            });

            const pass = encoder.beginRenderPass({
                colorAttachments,
                depthStencilAttachment: {
                    view: this.pipeline.getDepthTextureView(),
                    depthClearValue: 0.0,  // Reverse-Z: clear to 0.0 (far plane)
                    depthLoadOp: 'clear',
                    depthStoreOp: 'store',
                    // Stencil is cleared here and preserved for the cap pass
                    // that runs right after in the same frame.
                    stencilClearValue: 0,
                    stencilLoadOp: 'clear',
                    stencilStoreOp: 'store',
                },
            });

            // Global lighting environment: write the uniform once per frame
            // and bind at group(1) — every pipeline derived from the main
            // shader shares this layout, and bind groups persist across
            // setPipeline calls within the pass.
            const environment = resolveEnvironment(options.environment);
            this.pipeline.updateEnvironment(options.environment);
            pass.setBindGroup(1, this.pipeline.getEnvironmentBindGroup());

            // Procedural sky background — replaces the flat clear colour.
            // Drawn before any geometry at the reverse-Z far plane with depth
            // writes off, so it never occludes anything and transparent
            // surfaces blend over it. (The viewer keeps this disabled while
            // the Cesium overlay composites underneath a transparent clear.)
            if (environment.skyEnabled) {
                if (!this.skyPass) {
                    this.skyPass = new SkyPass(device, {
                        colorFormat: this.device.getFormat(),
                        objectIdFormat: 'rgba8unorm',
                        depthFormat: this.pipeline.getDepthFormat(),
                        sampleCount: this.pipeline.getSampleCount(),
                    }, skyShaderSource);
                }
                // The sky shader rebuilds a per-pixel view ray from this
                // basis, so it must be the basis the frame's view matrix was
                // built from — `viewBasis`, not a local re-derivation
                // (#2489). The copy that used to live here guarded its two
                // divisors with `|| 1` and neither numerator, so a non-finite
                // camera coordinate made every axis NaN and the sky drew as a
                // flat undefined colour over the whole viewport; and for a
                // plan pose (`up` parallel to the view direction) it returned
                // zero-length axes, which is the same picture. Reading the
                // shared basis also keeps the horizon in the sky aligned with
                // the horizon in the geometry for free.
                const camBasis = viewBasis(
                    this.camera.getPosition(),
                    this.camera.getTarget(),
                    this.camera.getUp(),
                );
                this.skyPass.draw(pass, {
                    forward: [camBasis.forward.x, camBasis.forward.y, camBasis.forward.z],
                    right: [camBasis.right.x, camBasis.right.y, camBasis.right.z],
                    up: [camBasis.up.x, camBasis.up.y, camBasis.up.z],
                    fovY: this.camera.getFOV(),
                    aspect: this.canvas.height > 0 ? this.canvas.width / this.canvas.height : 1,
                }, environment);
            }

            pass.setPipeline(this.pipeline.getPipeline());

            // Check if we have batched meshes (preferred for performance)
            const allBatchedMeshes = this.scene.getBatchedMeshes();

            // PERFORMANCE FIX: Always use batch rendering when we have batches
            // Apply visibility filtering at the BATCH level instead of creating individual meshes
            // This keeps draw calls at ~50-200 instead of 60K+
            // #961: also enter this block when there are textured meshes but no
            // colour batches (e.g. a model that is only a textured type-geometry
            // boiler) — the textured sub-pass lives inside this block.
            if (allBatchedMeshes.length > 0 || this.scene.getTexturedMeshes().length > 0 || this.scene.getInstancedTemplates().length > 0) {
                // Frustum culling for batched meshes - skip entire batches outside the camera view
                // This is the primary performance optimization for large models (200K+ meshes)
                const frustum = FrustumUtils.fromViewProjMatrix(viewProj);

                // Contribution culling (issue #1682): skip batches whose world
                // AABB projects below a pixel threshold. Disabled unless the
                // caller opts in via options.contributionCull; the threshold is
                // raised while interacting (quality matters least mid-gesture).
                const contribThresholdPx = resolveContributionThresholdPx(
                    options.contributionCull,
                    interacting,
                );
                // LOD1 selection (issue #1682 phase 5): batches projecting below
                // this draw their simplified index range. Shares the projection
                // camera with contribution culling. Precedence is intentional:
                // a batch below the CULL threshold is skipped entirely, so a
                // lod threshold at or below the cull threshold never fires.
                const lodScreenPx = options.lod && options.lod.screenPx > 0 ? options.lod.screenPx : 0;
                const lodBatches = new Set<number>();
                let cullCam: CullCameraState | null = null;
                if (contribThresholdPx > 0 || lodScreenPx > 0) {
                    const eye = this.camera.getPosition();
                    const tgt = this.camera.getTarget();
                    const dx = tgt.x - eye.x, dy = tgt.y - eye.y, dz = tgt.z - eye.z;
                    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
                    cullCam = {
                        eye,
                        // Degenerate (eye == target) stays zero-length — the
                        // projection helper fails open (never culls) on it.
                        viewDir: len > 0 ? { x: dx / len, y: dy / len, z: dz / len } : { x: 0, y: 0, z: 0 },
                        mode: this.camera.getProjectionMode(),
                        fovYRadians: this.camera.getFOV(),
                        orthoHalfHeight: this.camera.getOrthoSize(),
                        viewportHeightPx: this.canvas.height,
                    };
                }

                // Per-batch visibility (only meaningful while filtering is active).
                // A batch is visible if ANY of its elements are visible, fully
                // visible if ALL are. Cached across frames keyed by the visibility
                // version so the O(total element count) scan + per-batch visible-id
                // Set allocation happens once per visibility change, not per frame.
                // The cache map is keyed by batch object (immutable expressIds per
                // instance); a rebuilt batch is a new object → recomputed lazily.
                if (this._batchVisibilityEpoch !== this._visibilityVersion) {
                    this._batchVisibilityCache = new WeakMap();
                    this._batchVisibilityEpoch = this._visibilityVersion;
                }
                const batchVisibilityCache = this._batchVisibilityCache;
                const getBatchVisibility = (
                    batch: typeof allBatchedMeshes[number],
                ): { visible: boolean; fullyVisible: boolean; visibleIds?: Set<number> } => {
                    let vis = batchVisibilityCache.get(batch);
                    if (vis) return vis;
                    const total = batch.expressIds.length;
                    // Build the visible-id set in one pass; drop it for fully-visible
                    // batches (they draw from their own buffers, no subset needed).
                    const visibleIds = new Set<number>();
                    for (const expressId of batch.expressIds) {
                        const isHidden = options.hiddenIds?.has(expressId) ?? false;
                        const isIsolated = !hasIsolatedFilter || options.isolatedIds!.has(expressId);
                        if (!isHidden && isIsolated) visibleIds.add(expressId);
                    }
                    const fullyVisible = visibleIds.size === total;
                    vis = {
                        visible: visibleIds.size > 0,
                        fullyVisible,
                        visibleIds: fullyVisible ? undefined : visibleIds,
                    };
                    batchVisibilityCache.set(batch, vis);
                    return vis;
                };

                // Separate batches into opaque and transparent, filtering by visibility
                // IMPORTANT: Only render FULLY visible batches - partially visible batches
                // need individual mesh rendering to show only the visible elements
                const opaqueBatches: typeof allBatchedMeshes = [];
                const transparentBatches: typeof allBatchedMeshes = [];

                // PERFORMANCE FIX: Track partially visible batches for sub-batch rendering
                // Instead of creating 10,000+ individual meshes, we create cached sub-batches
                const partiallyVisibleBatches: Array<{
                    sourceBatchKey: string;
                    colorKey: string;
                    visibleIds: Set<number>;
                    color: [number, number, number, number];
                }> = [];

                // Push a partial sub-batch entry, splitting by promotion when needed.
                // For transparent parent batches with mixed override membership, this
                // emits two entries (`:promoted` and `:remaining`) so non-overridden
                // batchmates keep their native transparent routing instead of getting
                // dragged opaque alongside the overridden ones.
                const pushVisibleAsPartial = (
                    sourceBatch: typeof allBatchedMeshes[number],
                    visibleIds: Set<number>,
                    isTransparent: boolean,
                ) => {
                    const baseKey = `${sourceBatch.colorKey}:${sourceBatch.id}`;
                    if (!isTransparent) {
                        partiallyVisibleBatches.push({
                            sourceBatchKey: baseKey,
                            colorKey: sourceBatch.colorKey,
                            visibleIds,
                            color: sourceBatch.color,
                        });
                        return;
                    }
                    const split = splitVisibleIdsByPromotion(visibleIds, colorOverrides);
                    // No promotion or every visible id promoted → single sub-batch,
                    // classifier downstream routes via shouldRouteBatchTransparent.
                    if (split == null || split.remaining.size === 0) {
                        partiallyVisibleBatches.push({
                            sourceBatchKey: baseKey,
                            colorKey: sourceBatch.colorKey,
                            visibleIds,
                            color: sourceBatch.color,
                        });
                        return;
                    }
                    // Mixed — emit one promoted (opaque-routed) and one remaining
                    // (transparent-routed) sub-batch. Distinct sourceBatchKeys so the
                    // partial-batch cache can hold both simultaneously.
                    partiallyVisibleBatches.push({
                        sourceBatchKey: `${baseKey}:promoted`,
                        colorKey: sourceBatch.colorKey,
                        visibleIds: split.promoted,
                        color: sourceBatch.color,
                    });
                    partiallyVisibleBatches.push({
                        sourceBatchKey: `${baseKey}:remaining`,
                        colorKey: sourceBatch.colorKey,
                        visibleIds: split.remaining,
                        color: sourceBatch.color,
                    });
                };

                for (const batch of allBatchedMeshes) {
                    // Frustum culling: skip batches entirely outside the camera view
                    if (batch.bounds) {
                        const batchAABB = { min: batch.bounds.min, max: batch.bounds.max };
                        if (!FrustumUtils.isAABBVisible(frustum, batchAABB)) {
                            frameBatchesFrustumCulled++;
                            continue; // Entire batch is off-screen
                        }
                        if (cullCam) {
                            const px = projectedAabbRadiusPx(batch.bounds.min, batch.bounds.max, cullCam);
                            // Contribution cull: the whole batch projects below the
                            // pixel threshold — drawing it could change at most a
                            // (sub-)pixel. Selected entities still highlight: the
                            // selection pass draws per-mesh, independent of batches.
                            if (contribThresholdPx > 0 && px < contribThresholdPx) {
                                frameBatchesContributionCulled++;
                                continue;
                            }
                            // LOD1: small-but-visible batches draw the simplified
                            // index range over the same vertices.
                            if (lodScreenPx > 0 && px < lodScreenPx && batch.lod1IndexBuffer) {
                                lodBatches.add(batch.id);
                            }
                        }
                    }

                    const alpha = alphaForBatch(batch, batch.color[3]);
                    const nativelyTransparent = alpha < 0.99;

                    // Check visibility
                    if (hasVisibilityFiltering) {
                        const vis = getBatchVisibility(batch);
                        if (!vis.visible) continue; // Skip completely hidden batches

                        // Handle partially visible batches - create sub-batches instead of individual meshes
                        if (!vis.fullyVisible) {
                            // The visible subset was computed once for this
                            // visibility epoch (cached) — reuse it, don't rebuild.
                            const visibleIds = vis.visibleIds;
                            if (visibleIds && visibleIds.size > 0) {
                                pushVisibleAsPartial(batch, visibleIds, nativelyTransparent);
                            }
                            // A COLD parent has no CPU meshData, so the partial
                            // sub-batch above comes back empty — queue the
                            // residency restore or the visible subset would
                            // stay missing under hide/isolate forever.
                            if (batch.gpuResident === false) {
                                this.scene.requestBatchResidency(batch);
                            }
                            continue; // Don't add batch to render list
                        }
                    }

                    // Fully visible (or no filtering) — this batch draws from its OWN
                    // GPU buffers. An evicted batch (residency budget, #1682 phase 3a)
                    // is skipped for a frame while its rebuild is queued; the partial
                    // path above is unaffected (sub-batches own separate buffers built
                    // from CPU meshData).
                    if (batch.gpuResident === false) {
                        this.scene.requestBatchResidency(batch);
                        frameBatchesNotResident++;
                        continue;
                    }
                    this.scene.recordBatchDrawn(batch);

                    // Transparent batches with mixed
                    // override membership must be split so non-overridden batchmates
                    // stay transparent — see splitVisibleIdsByPromotion / issue #677.
                    if (nativelyTransparent) {
                        const split = splitVisibleIdsByPromotion(batch.expressIds, colorOverrides);
                        if (split != null && split.remaining.size > 0) {
                            // Mixed promotion — re-route through the partial-batch path
                            // with distinct sourceBatchKeys for each subset.
                            pushVisibleAsPartial(batch, new Set(batch.expressIds), true);
                            continue;
                        }
                    }

                    if (shouldRouteBatchTransparent(alpha, batch.expressIds, colorOverrides)) {
                        transparentBatches.push(batch);
                    } else {
                        opaqueBatches.push(batch);
                    }
                }

                // Build a uniform template ONCE per frame — shared across all batches.
                // Only the 4-float color (offset 32) differs per batch; everything else
                // (viewProj, identity model, material, section plane, flags) is identical.
                const tpl = this.uniformScratch;
                const tplFlags = this.uniformScratchU32;
                tpl.set(viewProj, 0);
                // Identity model matrix (positions already in world space)
                tpl[16] = 1; tpl[17] = 0; tpl[18] = 0; tpl[19] = 0;
                tpl[20] = 0; tpl[21] = 1; tpl[22] = 0; tpl[23] = 0;
                tpl[24] = 0; tpl[25] = 0; tpl[26] = 1; tpl[27] = 0;
                tpl[28] = 0; tpl[29] = 0; tpl[30] = 0; tpl[31] = 1;
                // Color placeholder — overwritten per batch
                // tpl[32..35] set per batch
                tpl[36] = 0.0; // metallic
                tpl[37] = 0.6; // roughness
                tpl[38] = 0; tpl[39] = 0; // padding
                if (sectionPlaneData) {
                    tpl[40] = sectionPlaneData.normal[0];
                    tpl[41] = sectionPlaneData.normal[1];
                    tpl[42] = sectionPlaneData.normal[2];
                    tpl[43] = sectionPlaneData.distance;
                } else {
                    tpl[40] = 0; tpl[41] = 0; tpl[42] = 0; tpl[43] = 0;
                }
                // Clip box (offset 48-55: min.xyz + pad, max.xyz + pad) → enable bit
                const tplClipBit = packClipBox(options.clipBox, tpl, 48);
                // flags layout (main shader):
                //   x = isSelected (0/1)
                //   y = section/clip bitfield:
                //       bit 0 = sectionEnabled, bit 1 = flipped, bit 2 = clipBoxEnabled
                //   z = edgeEnabled (0/1)
                //   w = edgeIntensityMilli
                tplFlags[0] = 0;
                tplFlags[1] =
                    (sectionPlaneData?.enabled ? 1 : 0) |
                    (options.sectionPlane?.flipped ? 2 : 0) |
                    tplClipBit;
                tplFlags[2] = edgeEnabledU32;
                tplFlags[3] = edgeIntensityMilliU32;

                // Helper function to render a batch — patches color into the shared template
                const renderBatch = (batch: typeof allBatchedMeshes[0]) => {
                    if (!batch.bindGroup || !batch.uniformBuffer) return;

                    // Patch only the per-batch color (4 floats at offset 32)
                    tpl[32] = batch.color[0];
                    tpl[33] = batch.color[1];
                    tpl[34] = batch.color[2];
                    tpl[35] = alphaForBatch(batch, batch.color[3]);

                    // Per-batch local frame: the batch's vertices are stored
                    // RELATIVE to batch.origin (f32-small), so set the model
                    // matrix translation column to origin (world = origin + pos).
                    // The 12 rotation/scale floats stay identity from the template;
                    // the translation lives at column-major indices 12/13/14 →
                    // tpl[28/29/30]. [0,0,0] for legacy absolute batches.
                    const o = batch.origin;
                    tpl[28] = o ? o[0] : 0;
                    tpl[29] = o ? o[1] : 0;
                    tpl[30] = o ? o[2] : 0;

                    // Quantized dequantization params (issue #1682 phase 6);
                    // zeroed for f32 batches (their pipelines ignore them).
                    const qz = batch.quantized;
                    tpl[56] = qz ? qz.min[0] : 0;
                    tpl[57] = qz ? qz.min[1] : 0;
                    tpl[58] = qz ? qz.min[2] : 0;
                    tpl[59] = qz ? qz.step : 0;

                    device.queue.writeBuffer(batch.uniformBuffer, 0, tpl);

                    // Single draw call for entire batch! LOD1-selected batches
                    // bind their simplified index range over the same vertices.
                    const useLod1 = batch.lod1IndexBuffer && batch.lod1IndexCount && lodBatches.has(batch.id);
                    pass.setBindGroup(0, batch.bindGroup);
                    pass.setVertexBuffer(0, batch.vertexBuffer);
                    if (useLod1) {
                        pass.setIndexBuffer(batch.lod1IndexBuffer!, 'uint32');
                        pass.drawIndexed(batch.lod1IndexCount!);
                        frameBatchesAtLod1++;
                    } else {
                        pass.setIndexBuffer(batch.indexBuffer, 'uint32');
                        pass.drawIndexed(batch.indexCount);
                    }
                    frameDrawCalls++;
                    frameBatchesDrawn++;
                };

                // Quantized batches (issue #1682 phase 6) draw through the
                // quantized pipeline variants; scene only quantizes after the
                // probe (enableQuantizedBatches) verified they exist, so the
                // base fallback here is type-safety, never taken.
                const pipeFor = (
                    batch: typeof allBatchedMeshes[0],
                    kind: 'opaque' | 'transparent' | 'overlay',
                ): GPURenderPipeline => {
                    const base = kind === 'opaque'
                        ? this.pipeline!.getPipeline()
                        : kind === 'transparent'
                            ? this.pipeline!.getTransparentPipeline()
                            : this.pipeline!.getOverlayPipeline();
                    if (!batch.quantized) return base;
                    return this.pipeline!.getQuantizedPipelineVariant(kind) ?? base;
                };

                // Render opaque batches with the opaque (double-sided) pipeline.
                // Material-layer slices render double-sided like all other IFC
                // geometry. They USED to be backface-culled to hide the coincident
                // interface caps of the old CLOSED per-layer slabs; since #1311 the
                // slabs are open bands whose UNION is the wall's watertight outer
                // skin (no caps ⇒ no coincident faces to z-fight). IFC winding is
                // not reliably outward, so culling those bands dropped inward-wound
                // faces and punched holes — the wall read HOLLOW even uncut.
                // Double-siding draws every face of the watertight skin ⇒ solid.
                pass.setPipeline(this.pipeline.getPipeline());
                for (const batch of opaqueBatches) {
                    pass.setPipeline(pipeFor(batch, 'opaque'));
                    renderBatch(batch);
                }
                pass.setPipeline(this.pipeline.getPipeline());

                // GPU-instancing pass — repeated geometry collated by the producer
                // into one template + a per-occurrence instance buffer (mat4 +
                // entityId + rgba), drawn with the instanced pipeline as
                // drawIndexed(indexCount, instanceCount). INERT until the worker
                // feeds shards (getInstancedTemplates() empty ⇒ no draws ⇒ the flat
                // path is unchanged). The per-instance matrix already folds the
                // IFC Z-up→WebGL Y-up swap, so the uniform's model is unused here;
                // we reuse the frame's viewProj + section + flags from `tpl`.
                const instancedTemplates = this.scene.getInstancedTemplates();
                // Cull templates ONCE per frame; the transparent instanced
                // sub-pass below reuses this list. Frustum: the union of the
                // occurrences' world AABBs off-screen ⇒ every occurrence is.
                // Contribution: the LARGEST occurrence projected at the union
                // box's nearest view depth is an upper bound for any single
                // occurrence — bolts-scattered-everywhere templates cull as
                // soon as no bolt can exceed the pixel threshold, even though
                // the union box itself is model-sized. Templates with a
                // selected occurrence are exempt so the highlight can't vanish.
                // CATIA-class models put ~97% of draw calls in this pass, so
                // this is where interactive frame cost lives (issue #1682).
                let visibleInstanced: InstancedTemplateGPU[] | readonly InstancedTemplateGPU[] =
                    instancedTemplates;
                if (instancedTemplates.length > 0) {
                    const kept: InstancedTemplateGPU[] = [];
                    for (const it of instancedTemplates) {
                        if (it.bounds) {
                            if (!FrustumUtils.isAABBVisible(frustum, it.bounds)) {
                                frameInstancedFrustumCulled++;
                                continue;
                            }
                            if (
                                contribThresholdPx > 0 &&
                                cullCam &&
                                it.selectedCount === 0 &&
                                projectedInstancedRadiusPx(it.bounds.min, it.bounds.max, it.maxOccRadius, cullCam) <
                                    contribThresholdPx
                            ) {
                                frameInstancedContributionCulled++;
                                continue;
                            }
                        }
                        kept.push(it);
                    }
                    visibleInstanced = kept;
                }
                if (visibleInstanced.length > 0) {
                    // Opaque instanced pass. flags.x bit 2 marks "instanced pass" so the
                    // shader routes per-instance opacity: opaque (or selected) occurrences
                    // draw here; translucent ones (lens/x-ray/compare overrides) are
                    // discarded and drawn in the transparent sub-pass below.
                    this.pipeline.writeRawUniforms(tpl, 0x4);
                    pass.setPipeline(this.pipeline.getInstancedPipeline());
                    pass.setBindGroup(0, this.pipeline.getBindGroup());
                    pass.setBindGroup(1, this.pipeline.getEnvironmentBindGroup());
                    for (const it of visibleInstanced) {
                        pass.setVertexBuffer(0, it.vertexBuffer);
                        pass.setVertexBuffer(1, it.instanceBuffer);
                        pass.setIndexBuffer(it.indexBuffer, 'uint32');
                        pass.drawIndexed(it.indexCount, it.instanceCount);
                        frameDrawCalls++;
                        frameInstancedDrawn++;
                    }
                    pass.setPipeline(this.pipeline.getPipeline());
                    // The TRANSPARENT instanced sub-pass is drawn later, alongside the
                    // flat transparent batches, so it blends after ALL opaque geometry
                    // (incl. the textured sub-pass below) has written depth.
                }

                // #961: textured meshes — dedicated sub-pass right after opaque
                // batches (writes depth + object-id, so overlay/section/picking
                // all behave like normal opaque geometry). Each mesh has its own
                // vertex buffer (with a UV lane), texture, sampler and bindGroup.
                const texturedMeshes = this.scene.getTexturedMeshes();
                if (texturedMeshes.length > 0) {
                    pass.setPipeline(this.pipeline.getTexturedPipeline());
                    for (const tm of texturedMeshes) {
                        // Honour hide/isolate — textured meshes bypass the batch
                        // visibility filtering above, so apply it per-mesh here or
                        // hidden/isolated elements would stay visible and keep
                        // writing depth + object IDs.
                        if (hasVisibilityFiltering) {
                            if (options.hiddenIds?.has(tm.expressId)) continue;
                            if (hasIsolatedFilter && !options.isolatedIds!.has(tm.expressId)) continue;
                        }
                        // Per-entity transparency override (e.g. a Pset/lens alpha):
                        // a fully-transparent override hides the mesh. NOTE: the
                        // textured pipeline is opaque, so a *partial* alpha can't
                        // blend — textured surfaces render opaque (acceptable for
                        // the photo/pattern type-geometry these carry; a transparent
                        // textured pipeline would be needed for true blending).
                        const txAlpha = alphaForBatch(
                            { expressIds: [tm.expressId], color: tm.color },
                            tm.color[3],
                        );
                        if (txAlpha <= 0.01) continue;
                        // Lens / Pset colour override tints the sampled texel — the
                        // batch overlay paint pass doesn't iterate textured meshes,
                        // so applying the override here is what recolours them.
                        const txOverride = colorOverrides?.get(tm.expressId);
                        // `world = origin + position`: the vertex buffer stores
                        // positions in this mesh's per-element local frame, so the
                        // model translation carries the world magnitude (#1973).
                        // Per mesh, which also overwrites the column renderBatch
                        // left set to the last opaque batch's origin. This used to
                        // be hoisted out of the loop and hard-zeroed — right only
                        // for the orphan type-geometry path (origin == 0), and it
                        // drew every textured occurrence collapsed toward the
                        // world origin.
                        tpl[28] = tm.origin[0]; tpl[29] = tm.origin[1]; tpl[30] = tm.origin[2];
                        tpl[32] = txOverride ? txOverride[0] : tm.color[0];
                        tpl[33] = txOverride ? txOverride[1] : tm.color[1];
                        tpl[34] = txOverride ? txOverride[2] : tm.color[2];
                        tpl[35] = txAlpha;
                        device.queue.writeBuffer(tm.uniformBuffer, 0, tpl);
                        pass.setBindGroup(0, tm.bindGroup);
                        pass.setVertexBuffer(0, tm.vertexBuffer);
                        pass.setIndexBuffer(tm.indexBuffer, 'uint32');
                        pass.drawIndexed(tm.indexCount);
                        frameDrawCalls++;
                    }
                    // Restore the opaque pipeline for the passes that follow.
                    pass.setPipeline(this.pipeline.getPipeline());
                }

                // PERFORMANCE FIX: Render partially visible batches as sub-batches (not individual meshes!)
                // This is the key optimization: instead of 10,000+ individual draw calls,
                // we create cached sub-batches with only visible elements and render them as single draw calls.
                // We also collect resolved opaque sub-batches so the section cap pass below can
                // include them in its parity count — otherwise hidden/isolated opaque geometry
                // would show open, un-capped cut holes.
                const opaqueSubBatches: typeof allBatchedMeshes = [];
                if (partiallyVisibleBatches.length > 0) {
                    for (const { sourceBatchKey, colorKey, visibleIds, color } of partiallyVisibleBatches) {
                        // Get or create a cached sub-batch for this visibility state
                        const subBatch = this.scene.getOrCreatePartialBatch(
                            sourceBatchKey,
                            colorKey,
                            visibleIds,
                            device,
                            this.pipeline,
                            this._partialBatchEpoch
                        );

                        if (subBatch) {
                            // Use opaque or transparent pipeline based on resolved alpha
                            // (not the parent batch's color[3] — that ignores transparencyOverrides).
                            // Promote to opaque if any expressId in the sub-batch carries a
                            // lens/Pset colour override, so the overlay paint pass finds depth.
                            const isTransparent = shouldRouteBatchTransparent(
                                alphaForBatch(subBatch, color[3]),
                                subBatch.expressIds,
                                colorOverrides,
                            );
                            if (isTransparent) {
                                pass.setPipeline(pipeFor(subBatch, 'transparent'));
                            } else {
                                // Opaque (incl. material-layer slices): double-sided.
                                // Layer slices are NOT culled — since #1311 they are
                                // open watertight-skin bands with unreliable winding,
                                // so culling punched holes (wall read hollow). See the
                                // full-batch path above.
                                pass.setPipeline(pipeFor(subBatch, 'opaque'));
                                opaqueSubBatches.push(subBatch);
                            }
                            // Render the sub-batch as a single draw call
                            renderBatch(subBatch);
                        }
                    }
                    // Reset to opaque pipeline for subsequent rendering
                    pass.setPipeline(this.pipeline.getPipeline());
                }

                // Render color overlay batches (lens coloring) on top of ALL opaque geometry.
                // Placed AFTER partial batches so depth buffer is complete for both full
                // and partial batches. Uses 'equal' depth compare — only paints where
                // original geometry wrote depth, so hidden entities never leak through.
                //
                // flags.x bit 1 = overlay: tells the shader to preserve baseColor.a
                // (the overlay pipeline now has src-alpha blending so low-alpha ghost
                // tints composite correctly against the opaque pass) AND skip the
                // glass-fresnel branch (which is meant for real glass materials and
                // would whiten low-alpha colour overrides at grazing angles).
                const overrideBatches = this.scene.getOverrideBatches();
                if (overrideBatches.length > 0) {
                    pass.setPipeline(this.pipeline.getOverlayPipeline());
                    // bit 1 = overlay; bit 5 (32) = emphasize (pop) — see shader.
                    tplFlags[0] = options.emphasizeOverrides ? (2 | 32) : 2;
                    for (const batch of overrideBatches) {
                        pass.setPipeline(pipeFor(batch, 'overlay'));
                        renderBatch(batch);
                    }
                    tplFlags[0] = 0;  // restore for any downstream use of the template
                    pass.setPipeline(this.pipeline.getPipeline());
                }

                // Filled, hatched 3D cut surfaces are now rendered by
                // Section2DOverlayRenderer using the exact polygons from
                // SectionCutter (triangle-plane intersection). The old
                // stencil-parity SectionCapRenderer is no longer in the
                // render loop — parity XOR on non-manifold IFC geometry
                // leaks stencil bits into empty sky, and no amount of
                // bounded quads or second-bit gating fixed that robustly.
                // See the 2D-overlay draw call further below in this same
                // render pass, which now emits the cap.

                // Prepare selected meshes once, then render them LAST so transparent batches
                // don't overwrite highlight color (glass otherwise appears unhighlighted).
                const visibleSelectedIds = new Set<number>();
                for (const selId of selectedExpressIds) {
                    if (options.hiddenIds?.has(selId)) continue;
                    if (hasIsolatedFilter && !options.isolatedIds!.has(selId)) continue;
                    visibleSelectedIds.add(selId);
                }

                // Only build per-mesh piece counts when we actually have selected
                // elements that need individual mesh rendering. This avoids iterating
                // 200K+ meshes every frame when nothing is selected.
                if (visibleSelectedIds.size > 0) {
                    const allMeshesFromScene = this.scene.getMeshes();
                    const existingPieceCounts = new Map<string, number>();
                    for (const mesh of allMeshesFromScene) {
                        const key = `${mesh.expressId}:${mesh.modelIndex ?? 'any'}`;
                        existingPieceCounts.set(key, (existingPieceCounts.get(key) ?? 0) + 1);
                    }

                    for (const selId of visibleSelectedIds) {
                        const pieces = this.scene.getMeshDataPieces(selId, selectedModelIndex);
                        if (!pieces || pieces.length === 0) continue;

                        const seenOrdinalsByKey = new Map<string, number>();
                        for (const piece of pieces) {
                            const meshKey = `${piece.expressId}:${piece.modelIndex ?? 'any'}`;
                            const ordinal = seenOrdinalsByKey.get(meshKey) ?? 0;
                            seenOrdinalsByKey.set(meshKey, ordinal + 1);
                            const baselineExisting = existingPieceCounts.get(meshKey) ?? 0;
                            if (ordinal < baselineExisting) continue;
                            this.createMeshFromData(piece);
                        }
                    }
                }

                const selectedMeshes = visibleSelectedIds.size > 0
                    ? this.scene.getMeshes().filter(mesh => {
                        if (!visibleSelectedIds.has(mesh.expressId)) return false;
                        if (selectedModelIndex !== undefined && mesh.modelIndex !== selectedModelIndex) return false;
                        return true;
                    })
                    : [];

                // Transparent instanced sub-pass — drawn here (after ALL opaque incl. the
                // textured sub-pass) so ghosted/x-rayed instanced occurrences blend over
                // a complete depth buffer. Only runs when an override actually made some
                // occurrence translucent (otherwise zero cost). flags.x bit 3 flips the
                // shader's opacity routing so only translucent occurrences draw here.
                const instancedTransparentPipeline = this.pipeline.getInstancedTransparentPipeline();
                if (
                    visibleInstanced.length > 0 &&
                    this.scene.hasTransparentInstances() &&
                    instancedTransparentPipeline !== null
                ) {
                    this.pipeline.writeRawUniforms(tpl, 0x4 | 0x8);
                    pass.setPipeline(instancedTransparentPipeline);
                    pass.setBindGroup(0, this.pipeline.getBindGroup());
                    pass.setBindGroup(1, this.pipeline.getEnvironmentBindGroup());
                    for (const it of visibleInstanced) {
                        pass.setVertexBuffer(0, it.vertexBuffer);
                        pass.setVertexBuffer(1, it.instanceBuffer);
                        pass.setIndexBuffer(it.indexBuffer, 'uint32');
                        pass.drawIndexed(it.indexCount, it.instanceCount);
                        frameDrawCalls++;
                    }
                    pass.setPipeline(this.pipeline.getPipeline());
                }

                // Render transparent BATCHED meshes with transparent pipeline (after opaque batches and selections)
                if (transparentBatches.length > 0) {
                    pass.setPipeline(this.pipeline.getTransparentPipeline());
                    for (const batch of transparentBatches) {
                        pass.setPipeline(pipeFor(batch, 'transparent'));
                        renderBatch(batch);
                    }
                }

                // Render transparent individual meshes with transparent pipeline
                if (transparentMeshes.length > 0) {
                    pass.setPipeline(this.pipeline.getTransparentPipeline());
                    for (const mesh of transparentMeshes) {
                        if (!mesh.bindGroup || !mesh.uniformBuffer) {
                            continue;
                        }

                        tpl.set(viewProj, 0);
                        tpl.set(mesh.transform.m, 16);
                        tpl[32] = mesh.color[0]; tpl[33] = mesh.color[1];
                        tpl[34] = mesh.color[2]; tpl[35] = alphaForMesh(mesh.expressId, mesh.color[3]);
                        tpl[36] = mesh.material?.metallic ?? 0.0;
                        tpl[37] = mesh.material?.roughness ?? 0.6;
                        tpl[38] = 0; tpl[39] = 0;
                        if (sectionPlaneData) {
                            tpl[40] = sectionPlaneData.normal[0];
                            tpl[41] = sectionPlaneData.normal[1];
                            tpl[42] = sectionPlaneData.normal[2];
                            tpl[43] = sectionPlaneData.distance;
                        } else {
                            tpl[40] = 0; tpl[41] = 0; tpl[42] = 0; tpl[43] = 0;
                        }
                        tplFlags[0] = 0;
                        tplFlags[1] =
                            (sectionPlaneData?.enabled ? 1 : 0) |
                            (options.sectionPlane?.flipped ? 2 : 0) |
                            tplClipBit;
                        tplFlags[2] = edgeEnabledU32;
                        tplFlags[3] = edgeIntensityMilliU32;

                        device.queue.writeBuffer(mesh.uniformBuffer, 0, tpl);

                        pass.setBindGroup(0, mesh.bindGroup);
                        pass.setVertexBuffer(0, mesh.vertexBuffer);
                        pass.setIndexBuffer(mesh.indexBuffer, 'uint32');
                        pass.drawIndexed(mesh.indexCount, 1, 0, 0, 0);
                        frameDrawCalls++;
                    }
                }

                // Ensure selected meshes have uniform buffers and bind groups
                for (const mesh of selectedMeshes) {
                    if (!mesh.uniformBuffer && this.pipeline) {
                        mesh.uniformBuffer = device.createBuffer({
                            size: this.pipeline.getUniformBufferSize(),
                            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
                        });
                        mesh.bindGroup = device.createBindGroup({
                            layout: this.pipeline.getBindGroupLayout(),
                            entries: [
                                {
                                    binding: 0,
                                    resource: { buffer: mesh.uniformBuffer },
                                },
                            ],
                        });
                    }
                }

                // Render selected meshes with highlight LAST (on top of transparent geometry too)
                for (const mesh of selectedMeshes) {
                    if (!mesh.bindGroup || !mesh.uniformBuffer) {
                        continue;
                    }

                    tpl.set(viewProj, 0);
                    tpl.set(mesh.transform.m, 16);
                    tpl[32] = mesh.color[0]; tpl[33] = mesh.color[1];
                    tpl[34] = mesh.color[2]; tpl[35] = mesh.color[3];
                    tpl[36] = mesh.material?.metallic ?? 0.0;
                    tpl[37] = mesh.material?.roughness ?? 0.6;
                    tpl[38] = 0; tpl[39] = 0;
                    if (sectionPlaneData) {
                        tpl[40] = sectionPlaneData.normal[0];
                        tpl[41] = sectionPlaneData.normal[1];
                        tpl[42] = sectionPlaneData.normal[2];
                        tpl[43] = sectionPlaneData.distance;
                    } else {
                        tpl[40] = 0; tpl[41] = 0; tpl[42] = 0; tpl[43] = 0;
                    }
                    tplFlags[0] = 1; // isSelected
                    tplFlags[1] =
                        (sectionPlaneData?.enabled ? 1 : 0) |
                        (options.sectionPlane?.flipped ? 2 : 0) |
                        tplClipBit;
                    tplFlags[2] = edgeEnabledU32;
                    tplFlags[3] = edgeIntensityMilliU32;

                    device.queue.writeBuffer(mesh.uniformBuffer, 0, tpl);

                    pass.setPipeline(this.pipeline.getSelectionPipeline());
                    pass.setBindGroup(0, mesh.bindGroup);
                    pass.setVertexBuffer(0, mesh.vertexBuffer);
                    pass.setIndexBuffer(mesh.indexBuffer, 'uint32');
                    pass.drawIndexed(mesh.indexCount, 1, 0, 0, 0);
                    frameDrawCalls++;
                }
            } else {
                // Fallback: render individual meshes (only when no batches exist)
                // Render opaque meshes with per-mesh bind groups
                for (const mesh of opaqueMeshes) {
                    if (mesh.bindGroup) {
                        pass.setBindGroup(0, mesh.bindGroup);
                    } else {
                        pass.setBindGroup(0, this.pipeline.getBindGroup());
                    }
                    pass.setVertexBuffer(0, mesh.vertexBuffer);
                    pass.setIndexBuffer(mesh.indexBuffer, 'uint32');
                    pass.drawIndexed(mesh.indexCount, 1, 0, 0, 0);
                    frameDrawCalls++;
                }

                // Render transparent meshes with transparent pipeline (alpha blending)
                if (transparentMeshes.length > 0) {
                    pass.setPipeline(this.pipeline.getTransparentPipeline());
                    for (const mesh of transparentMeshes) {
                        if (mesh.bindGroup) {
                            pass.setBindGroup(0, mesh.bindGroup);
                        } else {
                            pass.setBindGroup(0, this.pipeline.getBindGroup());
                        }
                        pass.setVertexBuffer(0, mesh.vertexBuffer);
                        pass.setIndexBuffer(mesh.indexBuffer, 'uint32');
                        pass.drawIndexed(mesh.indexCount, 1, 0, 0, 0);
                        frameDrawCalls++;
                    }
                }
            }

            // Draw point clouds (IFCx inline + streamed LAS/LAZ).
            // Shares the depth buffer + section plane state with the mesh pipeline so
            // points occlude triangles and vice versa. The splat shader needs the
            // viewport size to convert pixel sizes into clip-space offsets.
            if (this.pointCloudRenderer && this.pointCloudRenderer.hasAssets()) {
                this.pointCloudRenderer.draw(pass, {
                    viewProj,
                    sectionPlane: sectionPlaneData
                        ? { ...sectionPlaneData, flipped: options.sectionPlane?.flipped === true }
                        : null,
                    viewport: { width: this.canvas.width, height: this.canvas.height },
                });
            }

            // Section-plane gizmo, 2D section cap and every standalone 3D
            // overlay (annotation / alignment / grid / DXF / clash / symbolic
            // text). One draw call into the pass — see RendererOverlays.draw().
            this.overlays.draw(pass, {
                options,
                viewProj,
                modelBounds: this.getModelBounds(),
                camera: this.camera,
                canvasWidth: this.canvas.width,
                canvasHeight: this.canvas.height,
            });

            pass.end();

            const canRunPostPass = (contactEnabled || separationEnabled)
                && this.postProcessor !== null;
            if (canRunPostPass && this.postProcessor) {
                this.postProcessor.updateOptions({
                    enableContactShading: contactEnabled,
                    contactRadius: visualEnhancement.contactShading.radius,
                    contactIntensity: visualEnhancement.contactShading.intensity,
                });
                this.postProcessor.apply(encoder, {
                    targetView: textureView,
                    // Depth-only view required because depth24plus-stencil8
                    // cannot be sampled as texture_depth_* with aspect 'all'.
                    depthView: this.pipeline.getDepthOnlyTextureView(),
                    objectIdView: this.pipeline.getObjectIdTextureView(),
                    contactQuality: contactEnabled && visualEnhancement.contactShading.quality === 'high' ? 'high' : 'low',
                    radius: Math.min(3.0, Math.max(1.0, visualEnhancement.contactShading.radius)),
                    intensity: contactEnabled ? Math.min(1.0, Math.max(0.0, visualEnhancement.contactShading.intensity)) : 0.0,
                    separationQuality: visualEnhancement.separationLines.quality === 'high' ? 'high' : 'low',
                    separationRadius: Math.min(2.0, Math.max(1.0, visualEnhancement.separationLines.radius)),
                    separationIntensity: separationEnabled ? Math.min(1.0, Math.max(0.0, visualEnhancement.separationLines.intensity)) : 0.0,
                    enableSeparationLines: separationEnabled,
                });
            }

            // Eye-Dome Lighting — runs AFTER contact/separation so it darkens
            // every layer uniformly. Cheap (~9 depth taps), only active when
            // there are point clouds in the scene and the user has enabled it.
            if (
                this.edlPass
                && this.edlOptions.enabled
                && this.pointCloudRenderer?.hasAssets()
            ) {
                this.edlPass.apply(
                    encoder,
                    {
                        targetView: textureView,
                        depthView: this.pipeline.getDepthOnlyTextureView(),
                    },
                    {
                        strength: this.edlOptions.strength,
                        radiusPx: this.edlOptions.radiusPx,
                        highQuality: this.edlOptions.highQuality,
                    },
                );
            }

            device.queue.submit([encoder.finish()]);

            this._lastFrameStats = {
                drawCalls: frameDrawCalls,
                batchesDrawn: frameBatchesDrawn,
                batchesFrustumCulled: frameBatchesFrustumCulled,
                batchesContributionCulled: frameBatchesContributionCulled,
                batchesNotResident: frameBatchesNotResident,
                batchesAtLod1: frameBatchesAtLod1,
                instancedDrawn: frameInstancedDrawn,
                instancedFrustumCulled: frameInstancedFrustumCulled,
                instancedContributionCulled: frameInstancedContributionCulled,
                timestamp: performance.now(),
            };

            // GPU residency budget (issue #1682 phase 3a): evict least-recently
            // drawn bucket batches after submit — destruction of just-submitted
            // buffers is deferred past in-flight work by WebGPU.
            this.scene.enforceGpuBudget();

            // Pop validation error scope and capture the exact error
            if (errorScopePushed) {
                errorScopePushed = false;
                this.drainErrorScope(device);
            }
        } catch (error) {
            // Balance the validation scope if we threw before popping it above —
            // an unpopped scope would capture every later frame's errors silently.
            // drainErrorScope logs a pop rejection (device loss) rather than
            // swallowing it.
            if (errorScopePushed) {
                errorScopePushed = false;
                this.drainErrorScope(device);
            }
            // Same policy as the outer catch since issue #2417 — a `DOMException`
            // from here is a device that died mid-frame, after
            // `getCurrentTexture()` had already succeeded, and it must latch
            // rather than degrade forever in silence.
            //
            // Safe to discriminate here because the encode region has no
            // healthy-device `DOMException` source (swept for #2417): its
            // `queue.writeBuffer` calls all use the 3-argument form over whole
            // typed-array views — plus one 5-argument call in
            // `point-cloud-uniforms.ts` whose offset and size are compile-time
            // constants matching its scratch array — so the spec's
            // `OperationError` preconditions are unreachable; the one
            // `copyExternalImageToTexture` copies the glyph atlas's own
            // never-externally-drawn canvas at its full fixed size, so neither
            // `SecurityError` nor a zero-size `OperationError` can arise; and
            // every other WebGPU call in the region (`createView`,
            // `createCommandEncoder`, `beginRenderPass`, the pass setters and
            // draws, `finish`, `submit`, `createBindGroup`) reports failure as
            // an asynchronous `GPUValidationError` through the error scope, not
            // as a throw. The region's real healthy-device failure is
            // `getOrCreatePartialBatch`'s `createBuffer({ mappedAtCreation:
            // true })`, and that throws a `RangeError` — which is exactly why
            // the discriminator keys on the TYPE and not on "a frame threw".
            this.containFrameThrow(error, 'encode');
        }
    }

    /**
     * Pick object at screen coordinates
     * Respects visibility filtering so users can only select visible elements
     * Returns PickResult with expressId and modelIndex for multi-model support
     *
     * Note: x, y are CSS pixel coordinates relative to the canvas element.
     * These are scaled internally to match the actual canvas pixel dimensions.
     *
     * Resolves null once the device is gone — see `pickPathAlive()`.
     */
    async pick(x: number, y: number, options?: PickOptions): Promise<PickResult | null> {
        if (!this.pickPathAlive()) return null;
        return this.pickingManager.pick(x, y, options, this.activePickClip());
    }

    /**
     * Whether the GPU pick path can still run — the same liveness contract
     * `render()` and `getGPUDevice()` apply, which the pick path used to skip.
     *
     * A pick is a full GPU round trip (render pass, `copyTextureToBuffer`,
     * `mapAsync` readback). Once the device is destroyed or lost, that readback
     * never completes: Chromium rejects the pending map with an AbortError
     * ("A valid external Instance reference no longer exists"). Nothing on the
     * pick path is in a position to handle it — the DOM click/contextmenu
     * handlers that reach here are `async` listeners whose promise nobody
     * awaits — so it escapes as an unhandled rejection, once per click, for as
     * long as the user keeps clicking a frozen viewport (#1901).
     *
     * Callers therefore degrade to "no hit" instead of throwing, matching how
     * `render()` degrades to "skip the frame". This is not a swallow: the GPU
     * call is never issued, so no error is being hidden. Consumers that want to
     * react to the loss subscribe to `onDeviceLost()`.
     */
    private pickPathAlive(): boolean {
        return !this.deviceLost && this.device.isInitialized();
    }

    /**
     * Section plane + clip box from the last render(), so the picker discards the
     * same fragments and clipped-away geometry can't be selected.
     */
    private activePickClip(): PickClipState {
        return { sectionPlane: this._activePickSection, clipBox: this._activePickClipBox };
    }

    /**
     * GPU-based rectangle pick. Drag-select returns the set of
     * `expressId`s touched by any pixel inside `[x0,y0]..[x1,y1]`
     * (CSS pixels, canvas-relative). Both meshes and point clouds
     * participate.
     *
     * See `PickingManager.pickRect` for the visibility-filter +
     * limitation notes.
     *
     * Resolves an empty set once the device is gone — see `pickPathAlive()`.
     */
    async pickRect(
        x0: number,
        y0: number,
        x1: number,
        y1: number,
        options?: PickOptions,
    ): Promise<Set<number>> {
        if (!this.pickPathAlive()) return new Set();
        return this.pickingManager.pickRect(x0, y0, x1, y1, options, this.activePickClip());
    }

    /**
     * Raycast into the scene to get precise 3D intersection point
     * This is more accurate than pick() as it returns the exact surface point
     *
     * Note: x, y are CSS pixel coordinates relative to the canvas element.
     * These are scaled internally to match the actual canvas pixel dimensions.
     */
    raycastScene(
        x: number,
        y: number,
        options?: PickOptions & { snapOptions?: Partial<SnapOptions> }
    ): { intersection: Intersection; snap?: SnapTarget } | null {
        return this.raycastEngine.raycastScene(x, y, options);
    }

    /**
     * Raycast with magnetic edge snapping behavior
     * This provides the "stick and slide along edges" experience
     *
     * Note: x, y are CSS pixel coordinates relative to the canvas element.
     * These are scaled internally to match the actual canvas pixel dimensions.
     */
    raycastSceneMagnetic(
        x: number,
        y: number,
        currentEdgeLock: EdgeLockInput,
        options?: PickOptions & { snapOptions?: Partial<SnapOptions> }
    ): MagneticSnapResult & { intersection: Intersection | null } {
        return this.raycastEngine.raycastSceneMagnetic(x, y, currentEdgeLock, options);
    }

    /**
     * Invalidate BVH cache (call when geometry changes)
     */
    invalidateBVHCache(): void {
        this.raycastEngine.invalidateBVHCache();
    }

    /**
     * Get the raycaster instance (for advanced usage)
     */
    getRaycaster(): Raycaster {
        return this.raycastEngine.getRaycaster();
    }

    /**
     * Get the snap detector instance (for advanced usage)
     */
    getSnapDetector(): SnapDetector {
        return this.raycastEngine.getSnapDetector();
    }

    /**
     * Clear all caches (call when geometry changes)
     */
    clearCaches(): void {
        this.raycastEngine.clearCaches();
    }

    // ─── Dirty-flag render scheduling ────────────────────────────────────
    // The animation loop is THE render path.  Everything else (mouse, touch,
    // keyboard, streaming, visibility changes, theme changes) calls
    // requestRender() to set the dirty flag.  The loop drains scene queues,
    // resolves render options via refs, and issues a single render() call.

    /**
     * Request a render on the next animation frame.
     * Safe to call many times per frame — only one render will happen.
     */
    requestRender(): void {
        this._renderRequested = true;
    }

    /**
     * Check whether a render has been requested without clearing the flag.
     * Used by the animation loop to test the dirty flag before committing
     * to render (e.g. when throttling may skip the frame).
     */
    peekRenderRequest(): boolean {
        return this._renderRequested;
    }

    /**
     * Consume the render request flag.  Returns true (and resets the flag)
     * if a render was requested since the last call.  Used by the animation
     * loop to decide whether to render.
     */
    consumeRenderRequest(): boolean {
        if (!this._renderRequested) return false;
        this._renderRequested = false;
        return true;
    }

    /**
     * Resize canvas
     */
    resize(width: number, height: number): void {
        // `canvas.width` is an IDL `unsigned long`, so it silently coerces a
        // non-finite or negative argument to **0** — a zero drawing buffer
        // that every pick guard in this package misses, because they all
        // check the bounding rect rather than the buffer. `unprojectToRay`
        // then divides by it. This is documented public API of a published
        // package (`docs/api/typescript.md`), so an external caller wiring a
        // ResizeObserver to it is the reachable route; both in-repo callers
        // already floor their own values. Keep the last usable size, the same
        // policy `setAspect` uses for the ratio it derives (#2473).
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
        this.canvas.width = width;
        this.canvas.height = height;
        this.camera.setAspect(width / height);
    }

    getCamera(): Camera {
        return this.camera;
    }

    getScene(): Scene {
        return this.scene;
    }

    // ─── Overlay facade ──────────────────────────────────────────────────
    // The section-plane gizmo, the 2D section drawing/cap and the symbolic
    // annotation overlays live in `RendererOverlays` (issue #2425). These
    // methods are the published surface; the bodies moved with the state.

    /**
     * Upload 2D section drawing data for 3D overlay rendering.
     *
     * Cardinal-axis call site: pass `axis` + `position` percentage and the
     * upload computes the plane offset along the cardinal axis using the
     * model bounds (or `sectionRange` override). 2D points are then lifted
     * to 3D via the cardinal-axis swap.
     *
     * Custom-plane call site (issue #243): pass `customPlane = { origin,
     * tangent, bitangent }`. The 2D points are lifted via the explicit
     * basis, exactly inverting the projection `SectionCutter` applied when
     * generating the polygons. Without this the cap silhouette lands off
     * the actual cutting plane (the bug PR #581 hid by suppressing the
     * cap entirely for non-cardinal planes).
     */
    uploadSection2DOverlay(
        polygons: CutPolygon2D[],
        lines: DrawingLine2D[],
        axis: 'down' | 'front' | 'side',
        position: number,  // 0-100 percentage
        sectionRange?: { min?: number; max?: number },  // Same storey-based range as section plane
        flipped: boolean = false,
        customPlane?: {
            origin:    [number, number, number];
            tangent:   [number, number, number];
            bitangent: [number, number, number];
        },
    ): void {
        this.overlays.uploadSection2DOverlay(polygons, lines, axis, position, sectionRange, flipped, customPlane);
    }

    /**
     * Clear the 2D section overlay
     */
    clearSection2DOverlay(): void {
        this.overlays.clearSection2DOverlay();
    }

    /**
     * Set the colour of the overlay lines (annotation / alignment / grid) and the
     * section-cut outline (RGBA, 0..1). Defaults to opaque black; theme it to keep
     * lines legible on a dark canvas. The matching label colour is per-text via
     * `SymbolicTextInput.color` on `uploadAnnotationTexts3D`.
     */
    setOverlayLineColor(color: readonly [number, number, number, number]): void {
        this.overlays.setOverlayLineColor(color);
    }

    /**
     * Upload pre-lifted 3D line-list vertices for the standalone annotation
     * overlay. Each segment is `[x1, y1, z1, x2, y2, z2]` in world space.
     * The overlay is drawn regardless of whether a section plane is active.
     * Pass an empty Float32Array to clear.
     */
    uploadAnnotationLines3D(vertices: Float32Array): void {
        this.overlays.uploadAnnotationLines3D(vertices);
    }

    /**
     * Clear the standalone annotation line overlay.
     */
    clearAnnotationLines3D(): void {
        this.overlays.clearAnnotationLines3D();
    }

    /**
     * Upload IfcAlignment centerline segments as a flat [x,y,z,x,y,z,...]
     * line-list in world space. Rendered as thin lines (not a ribbon mesh)
     * to match IfcGrid / IfcAnnotation. Pass an empty Float32Array to clear.
     */
    uploadAlignmentLines3D(vertices: Float32Array): void {
        this.overlays.uploadAlignmentLines3D(vertices);
    }

    /** Clear the alignment centerline overlay. */
    clearAlignmentLines3D(): void {
        this.overlays.clearAlignmentLines3D();
    }

    /**
     * Upload structural-grid (IfcGridAxis) segments as a flat [x,y,z,x,y,z,...]
     * line-list in world space (issue #967). Rendered as thin lines, mirroring
     * the alignment overlay. Pass an empty Float32Array to clear.
     *
     * Unlike alignment, grids do NOT expand model bounds: they're behind a
     * visibility toggle, so toggling them on must not reframe the camera (and
     * grid axes routinely extend past the model envelope).
     */
    uploadGridLines3D(vertices: Float32Array): void {
        this.overlays.uploadGridLines3D(vertices);
    }

    /** Clear the structural-grid overlay. */
    clearGridLines3D(): void {
        this.overlays.clearGridLines3D();
    }

    /**
     * Upload the DXF reference-layer's line paths as a flat
     * [x,y,z,x,y,z,...] line-list in world space (issue #2043, follow-up to
     * the 2D-only DXF underlay from #1782/#1929). Mirrors
     * `uploadGridLines3D`: a dedicated buffer so 3D DXF visibility is
     * independent of the 2D underlay's own toggle, and does NOT expand
     * model bounds/reframe the camera on upload — it's behind its own
     * visibility toggle, like grid axes. Pass an empty Float32Array to clear.
     */
    uploadDxfLines3D(vertices: Float32Array): void {
        this.overlays.uploadDxfLines3D(vertices);
    }

    /** Clear the 3D DXF reference-layer overlay. */
    clearDxfLines3D(): void {
        this.overlays.clearDxfLines3D();
    }

    /**
     * Show (or clear) the clash-overlap box: the wireframe AABB of a focused
     * clash, drawn in `color` so the overlap region reads as a distinct third
     * colour next to the two glowing clash elements (#1277). Pass `null` to
     * clear. `min`/`max` are world-space corners (clash works in world frame).
     */
    setClashOverlapBox(
        box: { min: [number, number, number]; max: [number, number, number]; color: [number, number, number, number] } | null,
    ): void {
        this.overlays.setClashOverlapBox(box);
    }

    /**
     * Draw the focused clash's CONTACT geometry as 3D line segments — the real
     * shared-face polygon outlines / intersection lines, not the AABB box.
     * `vertices` is a flat line-list (x,y,z per endpoint, 2 endpoints per
     * segment) in world frame. Pass `null` to clear. Shares the clash-box line
     * buffer, so only one of this / setClashOverlapBox is shown at a time.
     */
    setClashContactLines(
        lines: { vertices: Float32Array; color: [number, number, number, number] } | null,
    ): void {
        this.overlays.setClashContactLines(lines);
    }

    /**
     * Draw the focused clash's TRUE INTERSECTION VOLUME — the actual overlap
     * mesh from `clashIntersectionSolid` — as an opaque solid, so the clash
     * reads as a shape rather than a wireframe box or contact line (the
     * BIMcollab Zoom / Solibri presentation). Pass `null` to clear. Independent
     * of `setClashOverlapBox` / `setClashContactLines`: the caller decides
     * which one is current for a given clash (solid when the kernel resolved
     * one, box/lines as the fallback when it didn't).
     */
    setClashIntersectionSolid(
        solid: { positions: Float32Array | Float64Array; indices: Uint32Array; color: [number, number, number, number] } | null,
    ): void {
        this.overlays.setClashIntersectionSolid(solid);
    }

    /**
     * Upload filled IfcAnnotation regions for the symbolic overlay
     * (issue #653). Pass an empty array to clear.
     */
    uploadAnnotationFills3D(fills: readonly SymbolicFillInput[]): void {
        this.overlays.uploadAnnotationFills3D(fills);
    }

    /**
     * Upload IfcAnnotation text labels for the symbolic overlay
     * (issue #653). Pass an empty array to clear.
     */
    uploadAnnotationTexts3D(texts: readonly SymbolicTextInput[]): void {
        this.overlays.uploadAnnotationTexts3D(texts);
    }

    /**
     * Check if 2D section overlay has geometry to render
     */
    hasSection2DOverlay(): boolean {
        return this.overlays.hasSection2DOverlay();
    }

    /**
     * Get render pipeline (for batching)
     */
    getPipeline(): RenderPipeline | null {
        return this.pipeline;
    }

    /**
     * Check if renderer is fully initialized and ready to use.
     *
     * `ready` is part of the test, not decoration: between `init()` being called
     * and its queued body running, the device and pipeline still belong to the
     * PREVIOUS init and are about to be destroyed, so the other two conditions
     * alone would report a renderer that is on its way out as usable.
     *
     * So is the device-loss check. A lost device is never torn down —
     * `WebGPUDevice.destroy()` is the only thing that nulls the handle and an
     * involuntary loss (driver reset / VRAM exhaustion / GPU-process crash)
     * never calls it — so `isInitialized()` stays true, the pipeline stays
     * non-null, and `ready` stays set from the init that completed before the
     * loss. All three conditions therefore still hold while `render()` is a
     * no-op and `getGPUDevice()` returns null: the renderer would report itself
     * usable through this third door alone. Unlike the two revocations above
     * this one needs no generation scoping — an `init()` clears `ready`
     * synchronously, so a latch left standing until the queued body clears it
     * cannot make this method spuriously false in the meantime.
     */
    isReady(): boolean {
        return this.ready && !this.deviceLost && this.device.isInitialized() && this.pipeline !== null;
    }

    /**
     * Get the GPU device (returns null if not initialized, or if the device
     * has been lost).
     *
     * The device-lost check is load-bearing, not defensive tidiness. A lost
     * device is NOT torn down: `WebGPUDevice.destroy()` is the only thing that
     * nulls the handle and it is never called for an involuntary loss (TDR /
     * GPU-process crash / driver reset), so `isInitialized()` stays true and
     * this used to keep handing out a zombie `GPUDevice`. Every caller then
     * called `createBuffer()` on it, which throws — bypassing both `render()`'s
     * own deviceLost guard and the `onDeviceLost` listeners entirely.
     *
     * Returning null instead routes into the `if (!device) return` check that
     * every call site already has, so a lost device degrades to "stop
     * uploading" rather than an uncaught throw. See `isDeviceLost()` /
     * `onDeviceLost()` for the recovery contract.
     */
    getGPUDevice(): GPUDevice | null {
        if (!this.device.isInitialized() || this.deviceLost) {
            return null;
        }
        return this.device.getDevice();
    }

    /**
     * Capture a screenshot of the current view
     * Waits for GPU work to complete and captures exactly what's displayed
     * @returns PNG data URL or null if capture failed
     */
    async captureScreenshot(): Promise<string | null> {
        if (!this.device.isInitialized()) {
            console.warn('[Renderer] Cannot capture screenshot: not initialized');
            return null;
        }

        try {
            // Wait for any pending GPU work to complete before capturing
            // This ensures we capture the fully rendered frame
            const device = this.device.getDevice();
            await device.queue.onSubmittedWorkDone();

            // Capture exactly what's displayed on the canvas
            const dataUrl = this.canvas.toDataURL('image/png');
            return dataUrl;
        } catch (error) {
            console.error('[Renderer] Screenshot capture failed:', error);
            return null;
        }
    }

    /**
     * Destroy the renderer and release all GPU resources.
     *
     * Cleans up scene buffers, render pipeline textures, picking resources,
     * post-processing buffers, section-plane renderers, and snap caches.
     * After calling this method the renderer is no longer usable.
     * Safe to call multiple times (idempotent).
     *
     * An `init()` still in flight is invalidated too. It is parked on
     * `await device.init(...)`, and without the generation bump below it resumes
     * after this returns, allocates a complete replacement GPU stack that nothing
     * references, and re-publishes `ready` — resolving `whenReady()` waiters
     * against a renderer the host has already torn down (#2465). The bump is what
     * `initOnce()` re-checks after its await, and what makes `markReady()` refuse
     * the stale completion.
     *
     * This is why the teardown itself lives in `teardown()`: `initOnce()` runs it
     * on the PREVIOUS init's objects as part of its own re-init, and routing that
     * through here would have every init invalidate its own generation, leaving
     * `whenReady()` pending forever.
     *
     * Anyone parked in `whenReady()` is FAILED rather than left pending. Nothing
     * after this call can make the wait true — the invalidation above is exactly
     * what stops the in-flight init from publishing readiness, and a host that
     * remounts builds a new `Renderer` rather than re-initialising this one — so
     * leaving the promise unsettled suspends the caller's async frame for the
     * lifetime of the page. `apps/viewer`'s point-cloud drop is one of those
     * frames: it captured this instance before the teardown, and would stop
     * mid-load with the spinner still up and no error to report. See
     * `whenReady()` for the rejection contract.
     */
    destroy(): void {
        this.initGeneration++;
        this.destroyed = true;
        this.teardown();
        this.rejectReadyWaiters(rendererDestroyedError());
    }

    /**
     * Release every GPU object this renderer owns, WITHOUT invalidating an
     * in-flight init. Callers: the public `destroy()` (which invalidates first)
     * and `initOnce()`, tearing down the previous init before building its own.
     */
    private teardown(): void {
        // Nothing below survives this call, so `whenReady()` / `isReady()` must
        // go back to waiting. Set first: every release below is synchronous, but
        // the flag is what a caller holding a live reference actually reads.
        this.ready = false;

        // Scene mesh GPU buffers
        this.scene.clear();
        // Re-arm the section-bounds diagnostic log for the next model.
        this._loggedSectionBounds = false;

        // Render pipelines (textures + uniform buffers)
        this.pipeline?.destroy();
        this.pipeline = null;

        // Picker GPU resources. The manager holds its own reference, so clear
        // that too — otherwise its `if (!this.picker) return null` guard keeps
        // pointing at a destroyed picker and a stray click still drives dead
        // GPU resources (#1901).
        this.picker?.destroy();
        this.picker = null;
        this.pickingManager.setPicker(null);

        // Post-processor uniform buffer
        this.postProcessor?.destroy();
        this.postProcessor = null;
        this.edlPass?.destroy();
        this.edlPass = null;
        this.skyPass?.destroy();
        this.skyPass = null;

        // Section-plane gizmo, 2D section overlay and the symbolic annotation
        // pipelines — see RendererOverlays.destroy().
        this.overlays.destroy();

        // Point cloud GPU resources
        this.pointCloudRenderer?.clear();
        this.pointCloudRenderer = null;

        // BIM ↔ scan deviation pipeline + cached BVH GPU buffers.
        // Done before queue.destroy() so the GPU calls inside
        // `destroy()` still have a valid device.
        this.deviationPipeline?.destroy();
        this.deviationPipeline = null;
        this.deviationBvhFingerprint = null;

        // Snap detector geometry cache
        this.raycastEngine.clearCaches();

        // Finally, release the GPU device itself. Every buffer/pipeline/texture
        // above was created from it and has already been destroyed, so nothing
        // will touch the device after this. Without it, an app that spins up a
        // renderer per model keeps N live devices (and their VRAM) alive. The
        // lost-handler special-cases reason 'destroyed' so this is not reported
        // as a fault. render() early-returns while the device is uninitialised.
        this.device.destroy();
    }

    /**
     * Get the canvas element
     */
    getCanvas(): HTMLCanvasElement {
        return this.canvas;
    }
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BCF (BIM Collaboration Format) hook
 *
 * Provides functions to create and apply BCF viewpoints, including:
 * - Capturing snapshots from the WebGPU canvas
 * - Converting between viewer camera state and BCF viewpoint format
 * - Applying viewpoints to the viewer (camera, selection, visibility)
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useViewerStore } from '@/store';
import type { BCFTopic, BCFViewpoint, BCFHeaderFile } from '@ifc-lite/bcf';
import {
  createViewpoint,
  extractViewpointState,
  computeMarkerPositions, translateViewpoint, viewpointFromWorld,
  type ViewerCameraState,
  type ViewerBounds,
  type OverlayBBox,
} from '@ifc-lite/bcf';
import type { Renderer } from '@ifc-lite/renderer';
import type { EntityRef } from '@/store/types';
import {
  globalIdToExpressId as globalIdToExpressIdLookup,
  resolveCapturedRefGlobalIds,
  resolveUniqueGlobalIds,
  type ComponentRef,
} from './bcfIdLookup';
import { resolveEntityRefGlobalIdFromState } from '@/store/resolveEntityRef';
import { fromGlobalIdFromModels } from '@/store/globalId';
import { resolvePresentationIds } from '@/lib/presentation/resolvePresentationIds';
import { deriveHeaderFiles } from './bcfHeaderFiles';
import { toast } from '@/components/ui/toast';
import { captureVisibility, describeVisibilityNotice } from './bcf/visibility-capture';
import { visibilityModelIdsForCapture } from './bcf/visibility-model-ids';
import { capturedSectionPlaneInput, type CapturedSectionPlane } from './bcf/section-plane-position';
import { bcfWorldOffset, renderFrameBounds, topicToRenderFrame } from './bcf/viewpoint-world-frame';
import { focusedClashComponents } from './bcf/focused-clash-components';
import { activeSectionPlane, cardinalSectionFlipped, clearSectionCut, showSectionCut } from '@/store/section-active';
import { SectionRestoreSession } from './bcf/section-restore';

// ============================================================================
// Types
// ============================================================================

interface UseBCFOptions {
  /** Ref to the WebGPU canvas for snapshot capture */
  canvasRef?: React.RefObject<HTMLCanvasElement | null>;
  /** Ref to the renderer for camera access */
  rendererRef?: React.RefObject<Renderer | null>;
  /** The BCF panel only: on unmount, give back the section cut viewpoints replaced (#5829). */
  restoreSectionOnUnmount?: boolean;
}

interface CreateViewpointOptions {
  /** Include a snapshot image */
  includeSnapshot?: boolean;
  /** Already-rendered PNG; camera/clipping still use the canonical conversion. */ snapshotOverride?: string;
  /** Exact cut rendered by a 2D section snapshot, independent of 3D clipping. */ capturedSectionPlane?: CapturedSectionPlane;
  /** Include selected entities */
  includeSelection?: boolean;
  /** Include hidden entities */
  includeHidden?: boolean;
  /**
   * Federated entity refs to record in the viewpoint's `<Selection>` as
   * "found objects", INDEPENDENT of the live viewer selection (merged in
   * alongside whatever `includeSelection` derives, deduped). When omitted and
   * `includeSelection` is on, the focused clash's painted elements are used
   * (`focusedClashComponents`): `focusClash` clears the live selection and
   * paints the pair only through the clash colour channel (#1277/#1339), so
   * without this every capture made while a clash is focused had no
   * `<Selection>` at all (#4806).
   */
  additionalSelectedRefs?: ComponentRef[];
  /** IFC GlobalIds already bound to a validated model revision by the caller. */
  additionalSelectedGuids?: string[];
  /**
   * Federated entity refs to record as BCF `<Coloring>`, grouped by an ARGB
   * hex colour (e.g. `'FFFF8000'`, matching `BCFColoring.color`). Defaults
   * like `additionalSelectedRefs`, to the focused clash's on-screen tint.
   */
  additionalColoredRefs?: { color: string; refs: ComponentRef[] }[];
  /** Coloring already bound to a validated model revision by the caller. */
  additionalColoredGuids?: { color: string; guids: string[] }[];
  /** Model-bound GUIDs that supplement an active numeric isolation allowlist. */
  additionalVisibleGuids?: string[];
  /** Abort when caller-owned scene identity changes while snapshot capture yields. */
  isCaptureStillValid?: () => boolean;
  /** Exact source models represented by the visibility state bound for this capture. */
  onVisibilityModelIdsCaptured?: (modelIds: readonly string[]) => void;
}
interface UseBCFResult {
  /** Create a viewpoint from current viewer state */
  createViewpointFromState: (options?: CreateViewpointOptions) => Promise<BCFViewpoint | null>;
  /**
   * Derive the BCF `<Header>` source files for a topic from the distinct source
   * models its viewpoint components reference (single-model fallback when none).
   */
  headerFilesForViewpoints: (
    viewpoints: readonly BCFViewpoint[],
    date?: string,
    exactModelIds?: readonly string[],
  ) => BCFHeaderFile[];
  /** Apply a viewpoint to the viewer */
  applyViewpoint: (viewpoint: BCFViewpoint, animate?: boolean) => void;
  /** Animate the camera to a BCF topic's 3D location (without changing selection/visibility) */
  zoomToTopic: (topic: BCFTopic) => void;
  /** Whether a topic has enough data to zoom to */
  canZoomToTopic: (topic: BCFTopic) => boolean;
  /** Capture a snapshot from the canvas */
  captureSnapshot: () => Promise<string | null>;
  /** Set the canvas ref for snapshot capture */
  setCanvasRef: (ref: React.RefObject<HTMLCanvasElement | null>) => void;
  /** Set the renderer ref for camera access */
  setRendererRef: (ref: React.RefObject<Renderer | null>) => void;
}

// ============================================================================
// Canvas Reference Store (module-level for cross-component access)
// ============================================================================

let globalCanvasRef: React.RefObject<HTMLCanvasElement | null> | null = null;
let globalRendererRef: React.RefObject<Renderer | null> | null = null;

/**
 * Set the global canvas reference (called by ViewportContainer)
 */
export function setGlobalCanvasRef(ref: React.RefObject<HTMLCanvasElement | null>): void {
  globalCanvasRef = ref;
}

/**
 * Set the global renderer reference (called by ViewportContainer)
 */
export function setGlobalRendererRef(ref: React.RefObject<Renderer | null>): void {
  globalRendererRef = ref;
}

/**
 * Get the global renderer instance (for direct rendering control, e.g., IDS snapshot capture)
 */
export function getGlobalRenderer(): Renderer | null {
  return globalRendererRef?.current ?? null;
}

/**
 * Get the live viewport canvas (for anything outside the viewport tree that
 * needs its CSS layout size, e.g. the to-scale PDF export deriving the scale
 * the viewport is currently displaying at, #2042).
 *
 * Read `clientHeight`/`clientWidth`, never `width`/`height`. The attributes are
 * the BACKING STORE size, which is conventionally `css * devicePixelRatio`, and
 * reading them for a physical-size derivation is wrong by exactly that ratio on
 * a Retina display. Since #5383 the renderer does scale this canvas's backing
 * store by the pixel ratio, so a caller that reached for `width` reports a
 * scale off by that ratio, and nothing about the resulting PDF looks wrong.
 */
export function getGlobalCanvas(): HTMLCanvasElement | null {
  return globalCanvasRef?.current ?? null;
}

/**
 * Clear the global references (called on unmount to prevent memory leaks)
 */
export function clearGlobalRefs(): void {
  globalCanvasRef = null;
  globalRendererRef = null;
}

/** Apply extracted BCF camera state without touching selection, visibility, or section plane. */
function applyCameraState(
  renderer: Renderer,
  camera: NonNullable<ReturnType<typeof extractViewpointState>['camera']>,
  animate: boolean,
): void {
  const rendererCamera = renderer.getCamera();
  if (animate) {
    rendererCamera.animateTo(camera.position, camera.target, 300);
  } else {
    rendererCamera.setPosition(camera.position.x, camera.position.y, camera.position.z);
    rendererCamera.setTarget(camera.target.x, camera.target.y, camera.target.z);
  }
}

// ============================================================================
// Hook
// ============================================================================

export function useBCF(options: UseBCFOptions = {}): UseBCFResult {
  const restoreSection = options.restoreSectionOnUnmount === true;
  const [sectionRestore] = useState(() => new SectionRestoreSession());
  useEffect(() => restoreSection ? () => { sectionRestore.restore(useViewerStore.getState, useViewerStore.setState); } : undefined, [restoreSection, sectionRestore]);
  const localCanvasRef = useRef<React.RefObject<HTMLCanvasElement | null> | null>(
    options.canvasRef ?? null
  );
  const localRendererRef = useRef<React.RefObject<Renderer | null> | null>(
    options.rendererRef ?? null
  );

  // Selection and visibility actions
  const setSelectedEntityId = useViewerStore((s) => s.setSelectedEntityId);
  const setSelectedEntityIds = useViewerStore((s) => s.setSelectedEntityIds);
  const setSelectedEntity = useViewerStore((s) => s.setSelectedEntity);
  const addEntitiesToSelection = useViewerStore((s) => s.addEntitiesToSelection);
  const clearEntitySelection = useViewerStore((s) => s.clearEntitySelection);
  const setHiddenEntities = useViewerStore((s) => s.setHiddenEntities);
  const setIsolatedEntities = useViewerStore((s) => s.setIsolatedEntities);

  // Get coordinate info for bounds
  const models = useViewerStore((s) => s.models);
  // Legacy single-model data store (used when models Map is empty)
  const ifcDataStore = useViewerStore((s) => s.ifcDataStore);

  /**
   * Get the canvas element (local ref or global)
   */
  const getCanvas = useCallback((): HTMLCanvasElement | null => {
    return localCanvasRef.current?.current ?? globalCanvasRef?.current ?? null;
  }, []);

  /**
   * Get the renderer instance (local ref or global)
   */
  const getRenderer = useCallback((): Renderer | null => {
    return localRendererRef.current?.current ?? globalRendererRef?.current ?? null;
  }, []);

  /**
   * Set the canvas ref for snapshot capture
   */
  const setCanvasRef = useCallback((ref: React.RefObject<HTMLCanvasElement | null>) => {
    localCanvasRef.current = ref;
  }, []);

  /**
   * Set the renderer ref for camera access
   */
  const setRendererRef = useCallback((ref: React.RefObject<Renderer | null>) => {
    localRendererRef.current = ref;
  }, []);

  /**
   * Capture a snapshot from the WebGPU canvas
   * Captures exactly what the user sees - no re-rendering
   */
  const captureSnapshot = useCallback(async (): Promise<string | null> => {
    const canvas = getCanvas();
    const renderer = getRenderer();
    if (!canvas) {
      console.warn('[useBCF] No canvas available for snapshot capture');
      return null;
    }

    try {
      // Wait for any pending GPU work to complete before capturing
      // This ensures we capture the fully rendered frame
      if (renderer) {
        const device = renderer.getGPUDevice();
        if (device) {
          await device.queue.onSubmittedWorkDone();
        }
      }

      // Capture exactly what's displayed on the canvas
      const dataUrl = canvas.toDataURL('image/png');
      return dataUrl;
    } catch (error) {
      console.error('[useBCF] Failed to capture snapshot:', error);
      return null;
    }
  }, [getCanvas, getRenderer]);

  /**
   * Get current camera state from renderer
   */
  const getCameraState = useCallback((): ViewerCameraState | null => {
    const renderer = getRenderer();
    if (!renderer) {
      console.warn('[useBCF] No renderer available for camera state');
      return null;
    }

    const camera = renderer.getCamera();
    const position = camera.getPosition();
    const target = camera.getTarget();
    const up = camera.getUp();
    const fov = camera.getFOV();
    // BCF 3.0 requires <AspectRatio> on every camera and `@ifc-lite/bcf`
    // refuses to invent one, so a viewpoint captured without it makes the
    // WHOLE export throw -- what a user hit after importing another tool's
    // 3.0 archive (readBCF keeps its version) and adding a topic (#3612).
    const aspectRatio = camera.getAspect();

    return {
      position,
      target,
      up, // Use actual camera up vector
      fov,
      isOrthographic: false,
      aspectRatio,
    };
  }, [getRenderer]);

  /**
   * Get model bounds from loaded models
   */
  const getBounds = useCallback((): ViewerBounds | null => renderFrameBounds(models), [models]);

  /** Render frame -> IFC world, IFC Z-up (#4806). BCF positions are world. */
  const getWorldOffset = useCallback(
    () => bcfWorldOffset(models, useViewerStore.getState().geometryResult),
    [models],
  );

  /**
   * Convert IFC GlobalId string to expressId (with model offset for federation)
   * Returns { expressId, modelId } or null if not found
   */
  const globalIdToExpressId = useCallback(
    (globalIdString: string): { expressId: number; modelId: string } | null =>
      globalIdToExpressIdLookup(globalIdString, models, ifcDataStore),
    [models, ifcDataStore]
  );

  /**
   * Create a viewpoint from current viewer state
   */
  const createViewpointFromState = useCallback(
    async (opts: CreateViewpointOptions = {}): Promise<BCFViewpoint | null> => {
      const {
        includeSnapshot = true, snapshotOverride, capturedSectionPlane,
        includeSelection = true,
        includeHidden = true,
      } = opts;
      const componentState = useViewerStore.getState();
      if (opts.isCaptureStillValid && !opts.isCaptureStillValid()) return null;
      // Default the found objects to the focused clash, whichever panel is capturing (#4806).
      const focusedClash = includeSelection
        ? focusedClashComponents(componentState.clashHighlightColors)
        : null;
      const additionalSelectedRefs = opts.additionalSelectedRefs ?? focusedClash?.selectedRefs;
      const additionalColoredRefs = opts.additionalColoredRefs ?? focusedClash?.coloredRefs;
      const resolveCapturedRef = (ref: ComponentRef): string[] => resolveCapturedRefGlobalIds(
        ref,
        componentState.models.keys(),
        (modelId, globalId) => componentState.resolveGlobalIdInModel(modelId, globalId),
        entityRef => resolveEntityRefGlobalIdFromState(componentState, entityRef),
      );
      const isCapturedRefPending = (globalId: number): boolean => {
        for (const [modelId, model] of componentState.models) {
          if (!componentState.resolveGlobalIdInModel(modelId, globalId)) continue;
          if (!model.ifcDataStore && model.loadState !== 'error') return true;
        }
        return false;
      };
      const hasCapturedRefWithoutGlobalId = (globalId: number): boolean => {
        for (const modelId of componentState.models.keys()) {
          const entityRef = componentState.resolveGlobalIdInModel(modelId, globalId);
          if (!entityRef) continue;
          if (!resolveEntityRefGlobalIdFromState(componentState, entityRef)) return true;
        }
        return false;
      };
      // Bind component identity before snapshot capture can yield. A model
      // replacement may reuse the same local express id for another entity.
      const selectedRefs: ComponentRef[] = [];
      if (includeSelection) {
        if (componentState.selectedEntityId !== null) selectedRefs.push(componentState.selectedEntityId);
        for (const id of componentState.selectedEntityIds) {
          if (id !== componentState.selectedEntityId) selectedRefs.push(id);
        }
      }
      selectedRefs.push(...(additionalSelectedRefs ?? []));
      const selectedGuids = resolveUniqueGlobalIds(selectedRefs, resolveCapturedRef);
      for (const guid of opts.additionalSelectedGuids ?? []) {
        if (!selectedGuids.includes(guid)) selectedGuids.push(guid);
      }
      const emittedColoredGuids = new Set<string>();
      const coloredGuids = [
        ...(additionalColoredRefs ?? []).map(({ color, refs }) => ({
          color, guids: resolveUniqueGlobalIds(refs, resolveCapturedRef, emittedColoredGuids),
        })),
        ...(opts.additionalColoredGuids ?? []).map(({ color, guids }) => ({
          color, guids: resolveUniqueGlobalIds(guids, (guid) => guid, emittedColoredGuids),
        })),
      ].filter((entry) => entry.guids.length > 0);
      // Capture visibility in the same pre-await state as the drawing buffer.
      // GPU completion below can yield long enough for another UI action to
      // mutate the store; mixing that newer state with the older PNG makes a
      // viewpoint reopen differently from its snapshot.
      const visibilityState = includeHidden ? componentState : undefined;
      if (visibilityState && opts.onVisibilityModelIdsCaptured) {
        opts.onVisibilityModelIdsCaptured(
          visibilityModelIdsForCapture(visibilityState, (id) => resolveCapturedRef(id)),
        );
      }

      // Snapshot FIRST, camera after: the PNG and the camera's `aspectRatio`
      // describe one frame, so they must come from one drawing buffer.
      // `captureSnapshot` awaits `queue.onSubmittedWorkDone()` before
      // `toDataURL`, and the render loop resizes the canvas and calls
      // `camera.setAspect` inside that wait (`renderer/src/index.ts`, the
      // `dimensionsChanged` branch). Reading the camera after closes the
      // window: an `await` resumes in a microtask, a rAF render is a task.
      let snapshot: string | undefined = snapshotOverride;
      if (!snapshot && includeSnapshot) {
        const captured = await captureSnapshot();
        if (opts.isCaptureStillValid && !opts.isCaptureStillValid()) return null;
        if (captured) {
          snapshot = captured;
        }
      }

      const cameraState = getCameraState();
      if (!cameraState) {
        console.warn('[useBCF] Cannot create viewpoint: no camera state');
        return null;
      }

      const bounds = getBounds() ?? undefined;
      const capturedSection = capturedSectionPlane ? capturedSectionPlaneInput(capturedSectionPlane, bounds) : null;
      // Only the cut on screen: `enabled` outlives the Section tool (#4806).
      const shown = activeSectionPlane(useViewerStore.getState());
      const viewerSectionPlane = capturedSection?.sectionPlane
        ?? (shown ? { axis: shown.axis, position: shown.position, enabled: true, flipped: cardinalSectionFlipped(shown) } : undefined);
      const viewpointBounds = capturedSection?.bounds ?? bounds;

      // Visibility GUIDs — the isolate allowlist or the hide-list, whichever the
      // viewer is in; what could not be named is reported to the author.
      // Pure decision in hooks/bcf/visibility-capture.ts (#4509, #4529).
      let hiddenGuids: string[] | undefined;
      let visibleGuids: string[] | undefined;
      if (visibilityState) {
        const capture = captureVisibility(
          visibilityState.isolatedEntities,
          visibilityState.hiddenEntities,
          resolveCapturedRef,
          isCapturedRefPending,
          hasCapturedRefWithoutGlobalId,
        );
        ({ visibleGuids, hiddenGuids } = capture);
        let notice = capture.notice;
        if (visibilityState.isolatedEntities !== null
          && opts.additionalVisibleGuids?.length
          && !notice?.pending) {
          visibleGuids = [...new Set([...(visibleGuids ?? []), ...opts.additionalVisibleGuids])];
          if (notice && visibleGuids.length > 0) notice = { ...notice, omitted: false };
        }
        if (notice) {
          const { unnameable, total, kind, omitted, pending, ids } = notice;
          console.warn(
            `[useBCF] ${unnameable} of ${total} ${kind} entities have no resolvable IFC GlobalId${pending ? ' (model metadata still loading)' : ''}; ${omitted ? 'omitting the viewpoint visibility component' : 'recording the rest'}. Global ids: ${ids.join(', ')}`,
          );
          const message = describeVisibilityNotice(notice);
          if (message) toast.info(message);
        }
      }

      // Camera and section plane are captured in the render frame; the
      // viewpoint is stored and written in world coordinates (#4806).
      return translateViewpoint(createViewpoint({
        camera: cameraState,
        sectionPlane: viewerSectionPlane,
        bounds: viewpointBounds,
        snapshot,
        selectedGuids,
        hiddenGuids,
        visibleGuids,
        coloredGuids,
      }), getWorldOffset());
    },
    [
      getWorldOffset,
      getCameraState,
      captureSnapshot,
      getBounds,
    ]
  );

  /**
   * Derive `<Header>` source files for a topic: one per distinct model it
   * references. Falls back to the single loaded model when nothing resolves, so
   * a lone-model topic still records its source file.
   */
  const headerFilesForViewpoints = useCallback(
    (viewpoints: readonly BCFViewpoint[], date?: string, exactModelIds?: readonly string[]): BCFHeaderFile[] => {
      const modelIds = new Set(exactModelIds);

      // Primary source: the live selection's model ids. A topic is created from
      // the current selection, and the selection knows each element's model
      // exactly. Resolving component GlobalIds instead would lose a model whose
      // elements share GlobalIds with another loaded model (revision
      // federations), collapsing every component onto the first match.
      const selected = useViewerStore.getState().selectedEntitiesSet;
      for (const key of selected) {
        const modelId = key.slice(0, key.lastIndexOf(':'));
        if (modelId) modelIds.add(modelId);
      }

      // Also union any model referenced by the viewpoint components but not the
      // live selection (e.g. hidden/coloured components, or a restored viewpoint).
      for (const vp of viewpoints) {
        const components: { ifcGuid?: string }[] = [
          ...(vp.components?.selection ?? []),
          ...(vp.components?.visibility?.exceptions ?? []),
          ...(vp.components?.coloring?.flatMap((c) => c.components) ?? []),
        ];
        for (const comp of components) {
          if (!comp.ifcGuid) continue;
          const resolved = globalIdToExpressId(comp.ifcGuid);
          if (resolved) modelIds.add(resolved.modelId);
        }
      }

      // Nothing resolved: record the single loaded model so a lone-model topic
      // still carries its provenance.
      if (modelIds.size === 0) {
        if (models.size === 1) {
          modelIds.add(models.keys().next().value!);
        } else if (models.size === 0 && ifcDataStore) {
          modelIds.add('legacy');
        }
      }

      return deriveHeaderFiles(modelIds, models, ifcDataStore, date);
    },
    [globalIdToExpressId, models, ifcDataStore],
  );

  /** Restore only the viewpoint camera (used by zoom-to-topic fallback). */
  const applyViewpointCamera = useCallback(
    (viewpoint: BCFViewpoint, animate = true) => {
      const renderer = getRenderer();
      if (!renderer) {
        console.warn('[useBCF] Cannot apply viewpoint camera: no renderer');
        return;
      }

      const bounds = getBounds() ?? undefined;
      const state = extractViewpointState(
        viewpointFromWorld(viewpoint, getWorldOffset(), bounds),
        bounds,
        renderer.getCamera().getDistance(),
      );
      if (state.camera) {
        applyCameraState(renderer, state.camera, animate);
      }
    },
    [getRenderer, getBounds, getWorldOffset],
  );

  /**
   * Apply a viewpoint to the viewer
   */
  const applyViewpoint = useCallback(
    (viewpoint: BCFViewpoint, animate = true) => {
      const renderer = getRenderer();
      if (!renderer) {
        console.warn('[useBCF] Cannot apply viewpoint: no renderer');
        return;
      }

      const bounds = getBounds() ?? undefined;

      // Extract state from viewpoint (once, reused for camera, section plane, and selection)
      const state = extractViewpointState(
        viewpointFromWorld(viewpoint, getWorldOffset(), bounds), // world -> render frame (#4806)
        bounds,
        renderer.getCamera().getDistance() // Use current distance as reference
      );
      const { camera, sectionPlane: viewpointSectionPlane } = state;

      if (camera) {
        applyCameraState(renderer, camera, animate);
      }

      // A viewpoint with clipping planes shows its cut (opening the Section
      // tool — the renderer draws a cut nowhere else); one without clears any
      // cut, parked ones included, so the view matches the topic (#4910).
      if (restoreSection) sectionRestore.noteBeforeViewpoint(useViewerStore.getState());
      if (viewpointSectionPlane?.enabled) {
        showSectionCut(useViewerStore.getState, viewpointSectionPlane);
      } else {
        clearSectionCut(useViewerStore.getState);
      }
      if (restoreSection) sectionRestore.noteAfterViewpoint(useViewerStore.getState());

      // Apply selection from BCF components. A federated viewpoint can select
      // elements across several models, so drive BOTH selection channels:
      // `selectedEntityIds` (global ids) for the renderer highlight, and the
      // model-aware `selectedEntitiesSet` (local {modelId, expressId} refs) for
      // property/federation context. (#1591: previously this collapsed to the
      // first element, losing every other selection and all model context.)
      if (state.selectedGuids.length > 0) {
        const globalIds: number[] = []; // renderer highlight (federated global ids)
        const refs: EntityRef[] = []; // model-aware multi-selection
        for (const guid of state.selectedGuids) {
          const result = globalIdToExpressId(guid);
          if (!result) continue;
          // result.expressId is already the federation-offset global id.
          globalIds.push(result.expressId);
          // Reverse the offset with the SAME store `models` map the forward
          // mapping used, not the renderer singleton, so refs can never desync
          // from globalIds if the registry lags the store.
          const localRef = fromGlobalIdFromModels(models, result.expressId);
          if (localRef) refs.push(localRef);
        }

        if (globalIds.length > 0) {
          // Reset both channels, then apply the full multi-model selection.
          clearEntitySelection();
          setSelectedEntityIds(globalIds);
          if (refs.length > 0) addEntitiesToSelection(refs);
          // Pin the primary selection to the first element for consistent
          // property display / framing (both channels keep the full set).
          setSelectedEntityId(globalIds[0]);
          if (refs.length > 0) setSelectedEntity(refs[0]);
        }
      } else {
        // Clear selection if viewpoint has no selection
        clearEntitySelection();
      }

      // Apply visibility from BCF components: isolation mode (visibleGuids
      // with defaultVisibility=false) or normal (hiddenGuids, default true).
      // `state.visibleGuids` is meaningfully nullable (`extractViewpointState`,
      // packages/bcf/src/viewpoint.ts): `null` means the viewpoint carries no
      // isolation channel, while a non-null array -- EMPTY included -- means
      // isolation WAS active when the viewpoint was captured, down to
      // "matched nothing". A `.length > 0` check here would read a captured
      // empty viewport (a real, spec-valid `DefaultVisibility="false"` with
      // no exceptions) as "no isolation" and fall into the `hiddenGuids`
      // branch below, restoring an unfiltered view instead of an empty one --
      // the read-side mirror of the same collapse fixed on the write side
      // above and in `createViewpoint`'s `hasVisible`.
      if (state.visibleGuids !== null) {
        // Isolation mode: only specified entities are visible
        const isolatedExpressIds = new Set<number>();
        for (const guid of state.visibleGuids) {
          const result = globalIdToExpressId(guid);
          if (result) isolatedExpressIds.add(result.expressId);
        }

        if (state.visibleGuids.length > 0 && isolatedExpressIds.size === 0) {
          // THIRD state. The viewpoint names elements, and NONE of them is in
          // the model currently loaded -- the ordinary case for a BCF file
          // authored against a different (or differently versioned) model.
          // That is not "isolation matched nothing": the isolation could not
          // be evaluated here at all. Applying it as an empty isolate would
          // hide every element of a model the viewpoint never spoke about,
          // which is indistinguishable from a broken viewer. Leave the
          // isolation channel off and say why, so the camera and selection
          // the viewpoint DOES carry still land on a visible model.
          setIsolatedEntities(null);
          toast.info(
            "Viewpoint visibility not applied: none of its elements are in the loaded model."
          );
        } else {
          // #3338: a viewpoint guid may name a geometry-less assembly whose parts carry the mesh.
          const resolver = useViewerStore.getState().cameraCallbacks.resolveHighlightIds;
          setIsolatedEntities(new Set(resolvePresentationIds(resolver, [...isolatedExpressIds])));
        }
      } else if (state.hiddenGuids.length > 0) {
        // Normal mode: specified entities are hidden
        const hiddenExpressIds = new Set<number>();
        for (const guid of state.hiddenGuids) {
          const result = globalIdToExpressId(guid);
          if (result) {
            hiddenExpressIds.add(result.expressId);
          }
        }

        if (hiddenExpressIds.size > 0) {
          setHiddenEntities(hiddenExpressIds);
        }
      } else {
        // Clear all visibility state if viewpoint has none
        setHiddenEntities(new Set());
      }
    },
    [
      getRenderer,
      getBounds,
      getWorldOffset,
      globalIdToExpressId,
      models,
      setSelectedEntityId,
      setSelectedEntityIds,
      setSelectedEntity,
      addEntitiesToSelection,
      clearEntitySelection,
      setHiddenEntities,
      setIsolatedEntities,
      restoreSection,
      sectionRestore,
    ]
  );

  const canZoomToTopic = useCallback((topic: BCFTopic): boolean => {
    return topic.viewpoints.length > 0;
  }, []);

  const zoomToTopic = useCallback(
    (topic: BCFTopic) => {
      const renderer = getRenderer();
      if (!renderer || topic.viewpoints.length === 0) return;

      const boundsLookup = (ifcGuid: string): OverlayBBox | null => {
        const result = globalIdToExpressId(ifcGuid);
        if (!result) return null;
        return renderer.getScene().getEntityBoundingBox(result.expressId);
      };

      const markers = computeMarkerPositions([topicToRenderFrame(topic, getWorldOffset(), getBounds())], boundsLookup, {
        targetDistance: renderer.getCamera().getDistance(),
      });

      if (markers.length > 0) {
        const marker = markers[0];

        if (marker.positionSource === 'component') {
          for (let i = topic.viewpoints.length - 1; i >= 0; i--) {
            const vp = topic.viewpoints[i];
            const guids = [
              ...(vp.components?.selection ?? []),
              ...(vp.components?.visibility?.exceptions ?? []),
            ];
            for (const comp of guids) {
              if (!comp.ifcGuid) continue;
              const bbox = boundsLookup(comp.ifcGuid);
              if (bbox) {
                void renderer.getCamera().frameBounds(bbox.min, bbox.max);
                return;
              }
            }
          }
        }

        const point = marker.connectorAnchor ?? marker.position;
        void renderer.getCamera().framePoint(point);
        return;
      }

      // Fallback: camera from latest viewpoint only — preserve selection/visibility
      applyViewpointCamera(topic.viewpoints[topic.viewpoints.length - 1], true);
    },
    [applyViewpointCamera, getRenderer, globalIdToExpressId, getWorldOffset, getBounds],
  );

  return {
    createViewpointFromState,
    headerFilesForViewpoints,
    applyViewpoint,
    zoomToTopic,
    canZoomToTopic,
    captureSnapshot,
    setCanvasRef,
    setRendererRef,
  };
}

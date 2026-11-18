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

import { captureNativeBcfViewpoint, bcfCameraState } from './bcf/capture-viewpoint';
import type { CreateViewpointOptions } from './bcf/viewpoint-options';
import { applyNativeBcfViewpoint } from './bcf/apply-viewpoint';
import { captureBcfFrame } from './bcf/capture-frame';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useViewerStore } from '@/store';
import type { BCFTopic, BCFViewpoint, BCFHeaderFile } from '@ifc-lite/bcf';
import {
  extractViewpointState,
  computeMarkerPositions, viewpointFromWorld,
  type ViewerBounds,
  type OverlayBBox,
} from '@ifc-lite/bcf';
import type { Renderer } from '@ifc-lite/renderer';
import {
  globalIdToExpressId as globalIdToExpressIdLookup,
} from './bcfIdLookup';
import { headerFilesForNativeViewpoints } from './bcf/header-for-viewpoints';
import { bcfWorldOffset, renderFrameBounds, topicToRenderFrame } from './bcf/viewpoint-world-frame';
import { SectionRestoreSession } from './bcf/section-restore';
import { applyCameraState } from './bcf/apply-camera-state';

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
const rendererRefListeners = new Set<() => void>();
export function subscribeGlobalRenderer(listener: () => void): () => void {
  rendererRefListeners.add(listener);
  return () => { rendererRefListeners.delete(listener); };
}

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
  for (const listener of rendererRefListeners) listener();
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
  for (const listener of rendererRefListeners) listener();
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
   * Get current camera state from renderer
   */
  const getCameraState = useCallback(() => bcfCameraState(getRenderer()), [getRenderer]);

  const captureFrame = useCallback(
    () => captureBcfFrame(getRenderer(), getCanvas(), getCameraState),
    [getRenderer, getCanvas, getCameraState],
  );
  const captureSnapshot = useCallback(async (): Promise<string | null> =>
    (await captureFrame())?.snapshot ?? null, [captureFrame]);

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
  const createViewpointFromState = useCallback((opts: CreateViewpointOptions = {}) =>
    captureNativeBcfViewpoint(getRenderer(), getCanvas(), opts), [getRenderer, getCanvas]);

  /**
   * Derive `<Header>` source files for a topic: one per distinct model it
   * references. Falls back to the single loaded model when nothing resolves, so
   * a lone-model topic still records its source file.
   */
  const headerFilesForViewpoints = headerFilesForNativeViewpoints;

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
  const applyViewpoint = useCallback((viewpoint: BCFViewpoint, animate = true) => {
    applyNativeBcfViewpoint(viewpoint, getRenderer(), animate, restoreSection ? sectionRestore : undefined);
  }, [getRenderer, restoreSection, sectionRestore]);

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

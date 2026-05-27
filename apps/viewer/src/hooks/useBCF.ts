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

import { useCallback, useRef } from 'react';
import { useViewerStore } from '@/store';
import type { BCFTopic, BCFViewpoint } from '@ifc-lite/bcf';
import {
  createViewpoint,
  extractViewpointState,
  computeMarkerPositions,
  type ViewerCameraState,
  type ViewerSectionPlane,
  type ViewerBounds,
  type OverlayBBox,
} from '@ifc-lite/bcf';
import type { Renderer } from '@ifc-lite/renderer';
import {
  globalIdToExpressId as globalIdToExpressIdLookup,
  expressIdToGlobalId as expressIdToGlobalIdLookup,
} from './bcfIdLookup';

// ============================================================================
// Types
// ============================================================================

interface UseBCFOptions {
  /** Ref to the WebGPU canvas for snapshot capture */
  canvasRef?: React.RefObject<HTMLCanvasElement | null>;
  /** Ref to the renderer for camera access */
  rendererRef?: React.RefObject<Renderer | null>;
}

interface CreateViewpointOptions {
  /** Include a snapshot image */
  includeSnapshot?: boolean;
  /** Include selected entities */
  includeSelection?: boolean;
  /** Include hidden entities */
  includeHidden?: boolean;
}

interface UseBCFResult {
  /** Create a viewpoint from current viewer state */
  createViewpointFromState: (options?: CreateViewpointOptions) => Promise<BCFViewpoint | null>;
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
 * Clear the global references (called on unmount to prevent memory leaks)
 */
export function clearGlobalRefs(): void {
  globalCanvasRef = null;
  globalRendererRef = null;
}

// ============================================================================
// Hook
// ============================================================================

export function useBCF(options: UseBCFOptions = {}): UseBCFResult {
  const localCanvasRef = useRef<React.RefObject<HTMLCanvasElement | null> | null>(
    options.canvasRef ?? null
  );
  const localRendererRef = useRef<React.RefObject<Renderer | null> | null>(
    options.rendererRef ?? null
  );

  // Store selectors
  const sectionPlane = useViewerStore((s) => s.sectionPlane);
  const hiddenEntities = useViewerStore((s) => s.hiddenEntities);
  const isolatedEntities = useViewerStore((s) => s.isolatedEntities);
  const selectedEntityId = useViewerStore((s) => s.selectedEntityId);
  const selectedEntityIds = useViewerStore((s) => s.selectedEntityIds);
  const setSectionPlaneAxis = useViewerStore((s) => s.setSectionPlaneAxis);
  const setSectionPlanePosition = useViewerStore((s) => s.setSectionPlanePosition);
  const toggleSectionPlane = useViewerStore((s) => s.toggleSectionPlane);
  const flipSectionPlane = useViewerStore((s) => s.flipSectionPlane);

  // Selection and visibility actions
  const setSelectedEntityId = useViewerStore((s) => s.setSelectedEntityId);
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

    return {
      position,
      target,
      up, // Use actual camera up vector
      fov,
      isOrthographic: false,
    };
  }, [getRenderer]);

  /**
   * Get model bounds from loaded models
   */
  const getBounds = useCallback((): ViewerBounds | null => {
    // Get bounds from first loaded model's geometry result
    for (const model of models.values()) {
      if (model.geometryResult?.coordinateInfo?.shiftedBounds) {
        return model.geometryResult.coordinateInfo.shiftedBounds;
      }
    }
    return null;
  }, [models]);

  /**
   * Convert expressId (with model offset) to IFC GlobalId string
   * Handles multi-model federation by finding the correct model and subtracting offset
   */
  const expressIdToGlobalId = useCallback(
    (expressId: number): string | null =>
      expressIdToGlobalIdLookup(expressId, models, ifcDataStore),
    [models, ifcDataStore]
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
        includeSnapshot = true,
        includeSelection = true,
        includeHidden = true,
      } = opts;

      const cameraState = getCameraState();
      if (!cameraState) {
        console.warn('[useBCF] Cannot create viewpoint: no camera state');
        return null;
      }

      // Get snapshot if requested
      let snapshot: string | undefined;
      if (includeSnapshot) {
        const captured = await captureSnapshot();
        if (captured) {
          snapshot = captured;
        }
      }

      // Convert section plane state
      const viewerSectionPlane: ViewerSectionPlane | undefined = sectionPlane.enabled
        ? {
            axis: sectionPlane.axis,
            position: sectionPlane.position,
            enabled: true,
            flipped: sectionPlane.flipped,
          }
        : undefined;

      // Get bounds for section plane conversion
      const bounds = getBounds() ?? undefined;

      // Get selected GUIDs - convert expressIds to IFC GlobalId strings
      const selectedGuids: string[] | undefined = includeSelection
        ? (() => {
            const guids: string[] = [];
            if (selectedEntityId !== null) {
              const guid = expressIdToGlobalId(selectedEntityId);
              if (guid) guids.push(guid);
            }
            for (const id of selectedEntityIds) {
              if (id !== selectedEntityId) {
                const guid = expressIdToGlobalId(id);
                if (guid) guids.push(guid);
              }
            }
            return guids.length > 0 ? guids : undefined;
          })()
        : undefined;

      // Get visibility GUIDs - either hidden (normal mode) or visible (isolation mode)
      let hiddenGuids: string[] | undefined;
      let visibleGuids: string[] | undefined;

      if (includeHidden) {
        if (isolatedEntities !== null && isolatedEntities.size > 0) {
          // Isolation mode: capture visible entities (defaultVisibility=false)
          const guids: string[] = [];
          for (const id of isolatedEntities) {
            const guid = expressIdToGlobalId(id);
            if (guid) guids.push(guid);
          }
          visibleGuids = guids.length > 0 ? guids : undefined;
        } else if (hiddenEntities.size > 0) {
          // Normal mode: capture hidden entities (defaultVisibility=true)
          const guids: string[] = [];
          for (const id of hiddenEntities) {
            const guid = expressIdToGlobalId(id);
            if (guid) guids.push(guid);
          }
          hiddenGuids = guids.length > 0 ? guids : undefined;
        }
      }

      // Create viewpoint
      return createViewpoint({
        camera: cameraState,
        sectionPlane: viewerSectionPlane,
        bounds,
        snapshot,
        selectedGuids,
        hiddenGuids,
        visibleGuids,
      });
    },
    [
      getCameraState,
      captureSnapshot,
      sectionPlane,
      getBounds,
      selectedEntityId,
      selectedEntityIds,
      hiddenEntities,
      isolatedEntities,
      expressIdToGlobalId,
    ]
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
        viewpoint,
        bounds,
        renderer.getCamera().getDistance() // Use current distance as reference
      );
      const { camera, sectionPlane: viewpointSectionPlane } = state;

      // Apply camera
      if (camera) {
        const rendererCamera = renderer.getCamera();

        if (animate) {
          // Animate to new position
          rendererCamera.animateTo(
            camera.position,
            camera.target,
            300 // 300ms animation
          );
        } else {
          // Set immediately
          rendererCamera.setPosition(camera.position.x, camera.position.y, camera.position.z);
          rendererCamera.setTarget(camera.target.x, camera.target.y, camera.target.z);
        }
      }

      // Apply section plane
      if (viewpointSectionPlane) {
        // Set axis and position
        setSectionPlaneAxis(viewpointSectionPlane.axis);
        setSectionPlanePosition(viewpointSectionPlane.position);

        // Toggle enabled state if needed
        const currentEnabled = sectionPlane.enabled;
        if (viewpointSectionPlane.enabled !== currentEnabled) {
          toggleSectionPlane();
        }

        // Toggle flip state if needed
        const currentFlipped = sectionPlane.flipped;
        if (viewpointSectionPlane.flipped !== currentFlipped) {
          flipSectionPlane();
        }
      }

      // Apply selection from BCF components
      if (state.selectedGuids.length > 0) {
        // Convert GlobalId strings to expressIds
        const selectedExpressIds: number[] = [];
        for (const guid of state.selectedGuids) {
          const result = globalIdToExpressId(guid);
          if (result) {
            selectedExpressIds.push(result.expressId);
          }
        }

        if (selectedExpressIds.length > 0) {
          // Select the first entity (primary selection)
          // The expressId here already includes the federation offset
          setSelectedEntityId(selectedExpressIds[0]);
          // Note: Multi-selection would require additional store support
        }
      } else {
        // Clear selection if viewpoint has no selection
        setSelectedEntityId(null);
      }

      // Apply visibility from BCF components
      // Either isolation mode (visibleGuids with defaultVisibility=false)
      // or normal mode (hiddenGuids with defaultVisibility=true)
      if (state.visibleGuids.length > 0) {
        // Isolation mode: only specified entities are visible
        const isolatedExpressIds = new Set<number>();
        for (const guid of state.visibleGuids) {
          const result = globalIdToExpressId(guid);
          if (result) {
            isolatedExpressIds.add(result.expressId);
          }
        }

        if (isolatedExpressIds.size > 0) {
          setIsolatedEntities(isolatedExpressIds);
        } else {
          setIsolatedEntities(null);
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
      sectionPlane,
      setSectionPlaneAxis,
      setSectionPlanePosition,
      toggleSectionPlane,
      flipSectionPlane,
      globalIdToExpressId,
      setSelectedEntityId,
      setHiddenEntities,
      setIsolatedEntities,
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

      const markers = computeMarkerPositions([topic], boundsLookup, {
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

      // Fallback: restore camera from the latest viewpoint only
      applyViewpoint(topic.viewpoints[topic.viewpoints.length - 1], true);
    },
    [applyViewpoint, getRenderer, globalIdToExpressId],
  );

  return {
    createViewpointFromState,
    applyViewpoint,
    zoomToTopic,
    canZoomToTopic,
    captureSnapshot,
    setCanvasRef,
    setRendererRef,
  };
}

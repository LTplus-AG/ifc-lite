/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Render updates hook for the 3D viewport
 * Handles visibility/selection/section/hover state re-render effects.
 *
 * These effects update refs and request a render — the animation loop
 * picks up the new state on the next frame.
 */

import { useEffect, type MutableRefObject } from 'react';
import type { Renderer, CutPolygon2D, DrawingLine2D, VisualEnhancementOptions } from '@ifc-lite/renderer';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import type { Drawing2D } from '@ifc-lite/drawing-2d';
import type { SectionPlane } from '@/store';
import { customPlaneCenter } from '@/store';
import { getThemeClearColor } from '../../utils/viewportUtils.js';

export interface UseRenderUpdatesParams {
  rendererRef: MutableRefObject<Renderer | null>;
  isInitialized: boolean;

  // Theme
  theme: string;
  clearColorRef: MutableRefObject<[number, number, number, number]>;
  visualEnhancementRef: MutableRefObject<VisualEnhancementOptions>;

  // Visibility/selection state (reactive values, not refs)
  hiddenEntities: Set<number>;
  isolatedEntities: Set<number> | null;
  selectedEntityId: number | null;
  selectedEntityIds: Set<number> | undefined;
  selectedModelIndex: number | undefined;
  activeTool: string;
  sectionPlane: SectionPlane;
  sectionRange: { min: number; max: number } | null;
  coordinateInfo?: CoordinateInfo;

  // Refs for theme re-render
  hiddenEntitiesRef: MutableRefObject<Set<number>>;
  isolatedEntitiesRef: MutableRefObject<Set<number> | null>;
  selectedEntityIdRef: MutableRefObject<number | null>;
  selectedModelIndexRef: MutableRefObject<number | undefined>;
  selectedEntityIdsRef: MutableRefObject<Set<number> | undefined>;
  sectionPlaneRef: MutableRefObject<SectionPlane>;
  sectionRangeRef: MutableRefObject<{ min: number; max: number } | null>;
  activeToolRef: MutableRefObject<string>;

  // Drawing 2D
  drawing2D: Drawing2D | null;
  show3DOverlay: boolean;
  showHiddenLines: boolean;
}

export function useRenderUpdates(params: UseRenderUpdatesParams): void {
  const {
    rendererRef,
    isInitialized,
    theme,
    clearColorRef,
    hiddenEntities,
    isolatedEntities,
    selectedEntityId,
    selectedEntityIds,
    selectedModelIndex,
    activeTool,
    sectionPlane,
    sectionRange,
    coordinateInfo,
    sectionPlaneRef,
    sectionRangeRef,
    drawing2D,
    show3DOverlay,
    showHiddenLines,
  } = params;

  // Theme-aware clear color update
  useEffect(() => {
    clearColorRef.current = getThemeClearColor(theme as 'light' | 'dark' | 'colorful');
    rendererRef.current?.requestRender();
  }, [theme, isInitialized]);

  // 2D section overlay: upload drawing data to renderer when available
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !isInitialized) return;

    if (activeTool === 'section' && drawing2D && drawing2D.cutPolygons.length > 0 && show3DOverlay) {
      const polygons: CutPolygon2D[] = drawing2D.cutPolygons.map((cp) => ({
        polygon: cp.polygon,
        ifcType: cp.ifcType,
        expressId: cp.entityId,
      }));

      const lines: DrawingLine2D[] = drawing2D.lines
        .filter((line) => showHiddenLines || line.visibility !== 'hidden')
        .map((line) => ({
          line: line.line,
          category: line.category,
        }));

      // For face-picked custom planes (issue #243), forward the plane
      // basis so `uploadDrawing` can lift 2D polygons back to 3D using
      // the same axes the cutter projected with — without that the cap
      // silhouette lands off the actual cutting plane (PR #581's bug).
      // The basis origin is `pickedAt` projected onto the LIVE plane
      // (`customPlaneCenter`), not `pickedAt` directly: as the user
      // drags the gizmo only `distance` changes, and pickedAt sits off
      // the live plane — using it here makes the lift drop the normal-
      // component, freezing the cap at the original pick location.
      const custom = sectionPlane.custom;
      const customPlane = custom
        ? {
            origin:    customPlaneCenter(custom),
            tangent:   custom.tangent,
            bitangent: custom.bitangent,
          }
        : undefined;

      renderer.uploadSection2DOverlay(
        polygons,
        lines,
        sectionPlane.axis,
        sectionPlane.position,
        sectionRangeRef.current ?? undefined,
        sectionPlane.flipped,
        customPlane,
      );
    } else {
      renderer.clearSection2DOverlay();
    }

    renderer.requestRender();
  }, [drawing2D, activeTool, sectionPlane, isInitialized, coordinateInfo, show3DOverlay, showHiddenLines]);

  // Re-render when visibility, selection, or section plane changes
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !isInitialized) return;

    renderer.requestRender();
  }, [hiddenEntities, isolatedEntities, selectedEntityId, selectedEntityIds, selectedModelIndex, isInitialized, sectionPlane, activeTool, sectionRange, coordinateInfo?.buildingRotation]);
}

export default useRenderUpdates;

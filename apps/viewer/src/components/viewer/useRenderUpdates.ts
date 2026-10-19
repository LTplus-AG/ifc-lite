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

import { useEffect, useRef, type MutableRefObject } from 'react';
import type { Renderer, VisualEnhancementOptions } from '@ifc-lite/renderer';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import type { Drawing2D } from '@ifc-lite/drawing-2d';
import type { SectionPlane } from '@/store';
import { useViewerStore } from '@/store';
import { capOverlayBasis, capOverlayInput } from '@/lib/section/cap-overlay';
import { capSignature } from '@/lib/section/section-cut-config';
import { planeRange, type RangeBounds } from '@/lib/section/section-render-clip';
import { getThemeClearColor } from '../../utils/viewportUtils.js';
import { rendererOverlayTheme } from '@/lib/viewport-ui/overlay-theme-renderer';
import { setClashColorsFromTheme } from '@/lib/clash/clash-colors';
import type { ThemeMode } from '@/store/slices/uiSlice';

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
  ghostExceptEntities: Set<number> | null;
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
  /** The bounds `sectionRangeRef` is read from: every other cutting plane's cap is placed over ITS OWN axis (#7545). */
  sectionBoundsRef?: MutableRefObject<RangeBounds | null>;
  activeToolRef: MutableRefObject<string>;

  // Drawing 2D
  drawing2D: Drawing2D | null;
  show3DOverlay: boolean;
  showHiddenLines: boolean;
}

export function useRenderUpdates(params: UseRenderUpdatesParams): void {
  // The other cutting planes (#7545) clip on their own; a change to one must draw a frame.
  const inactiveSectionPlanes = useViewerStore((s) => s.inactiveSectionPlanes);
  const extraCaps = useViewerStore((s) => s.sectionExtraCaps);
  const {
    rendererRef,
    isInitialized,
    theme,
    clearColorRef,
    hiddenEntities,
    isolatedEntities,
    ghostExceptEntities,
    selectedEntityId,
    selectedEntityIds,
    selectedModelIndex,
    activeTool,
    sectionPlane,
    sectionRange,
    coordinateInfo,
    sectionPlaneRef,
    sectionRangeRef,
    sectionBoundsRef,
    drawing2D,
    show3DOverlay,
    showHiddenLines,
  } = params;

  // Theme-aware clear color update, and the renderer's overlay theme (#5484):
  // selection, section-plane preview, every overlay line channel (annotation /
  // alignment / grid / DXF / LandXML lines and the section-cut outline, #5388)
  // and the clash tints, all sourced from the same design tokens (#5483). Runs
  // on theme change AND once the renderer finishes initializing (`isInitialized`
  // flips), so a renderer created after this effect first ran still gets themed.
  // `setOverlayTheme` writes its GPU uniforms only here, never per frame.
  useEffect(() => {
    clearColorRef.current = getThemeClearColor(theme as 'light' | 'dark' | 'colorful');
    // App-side clash tints (#1277/#1339) follow the theme regardless of
    // renderer readiness — they're plain JS state other code reads directly.
    setClashColorsFromTheme(theme as ThemeMode);
    if (isInitialized) rendererRef.current?.setOverlayTheme(rendererOverlayTheme(theme as ThemeMode));
    rendererRef.current?.requestRender();
  }, [theme, isInitialized]);

  // Which plane the drawing belongs to (#7545): the active plane when it arrived (a plane change
  // restarts the cut, so a newer drawing supersedes it). Choosing another plane must not lift the
  // previous plane's polygons onto the new plane until the new drawing has been cut; an edit to the
  // SAME plane (a drag) keeps its old cap following it, as it always did.
  const drawnFor = useRef<{ drawing: Drawing2D | null; planeId: string | undefined }>({ drawing: null, planeId: undefined });
  if (drawnFor.current.drawing !== drawing2D) drawnFor.current = { drawing: drawing2D, planeId: sectionPlane.id };
  const drawingIsThisPlanes = drawnFor.current.planeId === sectionPlane.id;

  // 2D section overlay: upload drawing data to renderer when available
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !isInitialized) return;

    if (activeTool === 'section' && drawing2D && drawingIsThisPlanes && drawing2D.cutPolygons.length > 0 && show3DOverlay) {
      const { polygons, lines } = capOverlayInput(drawing2D, showHiddenLines, sectionPlane.capStyle.fillMode);
      const customPlane = capOverlayBasis(sectionPlane.custom);

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
  }, [drawing2D, drawingIsThisPlanes, activeTool, sectionPlane, isInitialized, coordinateInfo, show3DOverlay, showHiddenLines]);

  // The other cutting planes' caps (#7545). A cap is uploaded only while it was cut for the plane's
  // CURRENT geometry; while a drag outruns the cutter the previous cap stays up, still on its own
  // plane, instead of being lifted onto the new one.
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !isInitialized) return;
    const shown = activeTool === 'section' && show3DOverlay ? inactiveSectionPlanes.filter((p) => p.enabled) : [];
    renderer.clearSection2DExtraOverlays(shown.map((p) => p.id));
    for (const plane of shown) {
      const cap = extraCaps[plane.id];
      if (!cap || !cap.signature.endsWith(`:${capSignature(plane)}`)) continue;
      if (cap.cutPolygons.length === 0) { renderer.clearSection2DOverlay(plane.id); continue; }
      const { polygons, lines } = capOverlayInput(cap, showHiddenLines, sectionPlane.capStyle.fillMode);
      renderer.uploadSection2DOverlay(
        polygons, lines, plane.axis, plane.position, planeRange(plane, sectionBoundsRef?.current) ?? undefined,
        plane.flipped, capOverlayBasis(plane.custom), plane.id,
      );
    }
    renderer.requestRender();
  }, [extraCaps, inactiveSectionPlanes, activeTool, isInitialized, coordinateInfo, show3DOverlay, showHiddenLines, sectionPlane.capStyle.fillMode]);

  // Re-render when visibility, selection, or section plane changes
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !isInitialized) return;

    renderer.requestRender();
  }, [hiddenEntities, isolatedEntities, ghostExceptEntities, selectedEntityId, selectedEntityIds, selectedModelIndex, isInitialized, sectionPlane, inactiveSectionPlanes, activeTool, sectionRange, coordinateInfo?.buildingRotation]);
}

export default useRenderUpdates;

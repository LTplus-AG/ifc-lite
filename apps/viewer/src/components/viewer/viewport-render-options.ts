/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Renderer, RenderOptions } from '@ifc-lite/renderer';
import type { UseAnimationLoopParams } from './useAnimationLoop';
import { useViewerStore } from '@/store';
import { chartAwareRendererSelectionFromStore } from '@/lib/charts/renderer-selection';
import { preserveClashPaintInSelection } from '@/lib/clash/renderer-selection';
import { sectionRenderClip } from '@/lib/section/section-render-clip';
import { hoverOutlineTarget } from './useHoverOutline';

/** One option builder for ordinary frames and owned captures (#6709). */
export function viewportRenderOptions(
  renderer: Renderer, p: UseAnimationLoopParams, continuous: boolean,
  throttleMs = 0, contributionCull?: RenderOptions['contributionCull'], lod?: RenderOptions['lod'],
): RenderOptions {
  const colors = renderer.getScene().getColorOverrides();
  const selection = preserveClashPaintInSelection(
    chartAwareRendererSelectionFromStore(p.selectedEntityIdRef.current, p.selectedEntityIdsRef.current, colors),
    p.clashHighlightColorsRef.current, colors,
  );
  const state = useViewerStore.getState();
  return {
    hiddenIds: p.hiddenEntitiesRef.current,
    isolatedIds: p.isolatedEntitiesRef.current,
    ghostExceptIds: p.ghostExceptEntitiesRef.current,
    selectedId: selection.selectedId, selectedIds: selection.selectedIds,
    emphasizeOverrides: (p.clashHighlightColorsRef.current?.size ?? 0) > 0,
    selectedModelIndex: p.selectedModelIndexRef.current,
    clearColor: p.clearColorRef.current,
    visualEnhancement: p.visualEnhancementRef.current,
    environment: p.environmentRef.current,
    sunShadows: p.sunShadowsRef.current ?? undefined,
    isInteracting: continuous, maxPixelRatio: continuous ? 1 : undefined,
    interactionFrameIntervalMs: throttleMs || undefined, contributionCull, lod,
    buildingRotation: p.coordinateInfoRef.current?.buildingRotation,
    ...sectionRenderClip(state.sceneState.section.visible, p.sectionPlaneRef.current, p.sectionRangeRef.current, state.activeTool),
    ...hoverOutlineTarget(),
    terrainClipY: p.terrainClipYRef.current ?? undefined,
  };
}

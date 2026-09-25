/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Hover state for the viewport's two hover consumers, the tooltip and the
 * pre-highlight outline (#5390). Extracted from `Viewport.tsx`, which sits at
 * its module-size budget.
 */

import { useEffect, type MutableRefObject } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import { useLatestRef } from '../../hooks/useLatestRef.js';
import { useHoverState } from '../../hooks/useViewerSelectors.js';

export function useHoverOutline(rendererRef: MutableRefObject<Renderer | null>) {
  const { hoverTooltipsEnabled, hoverHighlightEnabled, hoverState, clearHover } = useHoverState();
  // The pick runs whenever EITHER consumer wants it; each reads its own
  // enabled flag to decide what to do with the result.
  const hoverPickEnabledRef = useLatestRef(hoverTooltipsEnabled || hoverHighlightEnabled);
  const hoveredOutlineId = hoverHighlightEnabled ? hoverState.entityId : null;
  const hoveredIdRef = useLatestRef(hoveredOutlineId);
  const hoveredModelIndexRef = useLatestRef(hoverState.modelIndex);
  // An idle view only redraws on request, so a hover change must ask.
  useEffect(() => { rendererRef.current?.requestRender(); }, [rendererRef, hoveredOutlineId, hoverState.modelIndex]);
  // Clear only when NEITHER consumer wants hover state: the outline keeps it
  // live even with tooltips off.
  useEffect(() => {
    if (!hoverTooltipsEnabled && !hoverHighlightEnabled) clearHover();
  }, [hoverTooltipsEnabled, hoverHighlightEnabled, clearHover]);
  return { hoverPickEnabledRef, hoveredIdRef, hoveredModelIndexRef };
}

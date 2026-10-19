/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The selection / hover highlight of a section cap: the cut face of the
 * selected element is painted in the selection colour, so it is clear which part
 * of the cut belongs to what is selected (#7950). The cap polygons already carry
 * the element's `expressId`; the renderer recolours them from this map.
 */

import type { RenderOptions } from '@ifc-lite/renderer';

type Rgba = readonly [number, number, number, number];

/** The selection blue of the surface outline, as the cap fill takes it (sRGB-direct). */
export const CAP_SELECTION_COLOR: Rgba = [0.30, 0.62, 1.0, 1];
/** A lighter wash of it for the hovered element. */
export const CAP_HOVER_COLOR: Rgba = [0.62, 0.80, 1.0, 1];

interface CapHighlightState {
  activeTool: string | null;
  hoverHighlightEnabled: boolean;
  hoverState: { entityId: number | null };
}

/**
 * Element id → highlight colour for this frame, or `null` when no section tool
 * is active (the caps then never leave their built colours). Selection wins over
 * hover when the same element is both.
 */
export function sectionCapHighlight(
  state: CapHighlightState,
  selectedId: number | null | undefined,
  selectedIds: ReadonlySet<number> | undefined,
): NonNullable<RenderOptions['capHighlight']> | null {
  if (state.activeTool !== 'section') return null;
  const out = new Map<number, Rgba>();
  const hovered = state.hoverHighlightEnabled ? state.hoverState.entityId : null;
  if (hovered != null) out.set(hovered, CAP_HOVER_COLOR);
  if (selectedId != null) out.set(selectedId, CAP_SELECTION_COLOR);
  if (selectedIds) for (const id of selectedIds) out.set(id, CAP_SELECTION_COLOR);
  return out.size > 0 ? out : null;
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ComponentType } from 'react';
import { MeasureOverlay } from '@/components/viewer/tools/MeasurePanel';
import { SectionOverlay } from '@/components/viewer/tools/SectionPanel';
import { SectionToolbar } from '@/components/viewer/tools/SectionToolbar';
import { AddElementOverlay } from '@/components/viewer/tools/AddElementOverlay';
import { SelectEditScene } from '@/components/viewer/tools/SelectEditScene';
import { SplitBar, SplitScene } from '@/components/viewer/tools/SplitHud';
import { SpaceSketchOverlay } from '@/components/viewer/tools/SpaceSketchOverlay';

/**
 * `TOOL_HUD` registry (#5485, #5503; charter #5478 item 3).
 *
 * `ToolOverlays.tsx` reads this table instead of an `if (activeTool === …)`
 * chain: a tool declares its bar, its scene layer and its hint, and the HUD
 * places them — the bar in the top-center region, the hint in the
 * bottom-center region, both through `HudItem`, so a tool has no way to
 * invent its own `absolute` position the way `SunSkyPanel` (`top-32
 * right-4`) and `PointCloudPanel` (`bottom-4 left-4`) still do today.
 *
 * `ToolId` is the closed set of `activeTool` string literals in use across
 * the viewer (`store/slices/uiSlice.ts`'s `activeTool` is typed as a plain
 * `string`, so this is the one place that set is written down;
 * `isToolId` is the guard `ToolOverlays` uses to enter the table). Every
 * id gets a row, even an empty `{}` one, rather than making the table
 * `Partial`: a tool that has NOT declared a bar/scene/hint is still a
 * decision ("nothing here yet"), not an absence the table can't represent.
 */

export const TOOL_IDS = [
  'select',
  'measure',
  'section',
  'addElement',
  'split',
  'spaceSketch',
  'annotate',
  'cesium-placement',
  'polygon-area',
  'appearance-face',
  'cloud',
  'text',
  'walk',
  'none',
] as const;

export type ToolId = (typeof TOOL_IDS)[number];

export function isToolId(id: string): id is ToolId {
  return (TOOL_IDS as readonly string[]).includes(id);
}

export interface ToolHudEntry {
  /**
   * The tool's bar, mounted by `ToolOverlays` in the HUD's top-center region
   * (order 0) while the tool is active. A bar that owns further HUD
   * presence — Space Sketch's plan card, its parked chip, its live hint —
   * portals those through `HudItem` too, so region + order stay the only
   * placement knobs it has.
   */
  Bar?: ComponentType;
  /** The tool's world-anchored scene overlay layer, rendered inside `SceneOverlayRoot`. */
  Scene?: ComponentType;
  /**
   * An i18n catalogue KEY (not literal text) for the HUD's bottom-center
   * hint line while this tool is active — resolved with `t(hint)` by
   * `ToolOverlays`, which renders it into `HudHint`, so this table stays
   * locale-agnostic.
   */
  hint?: string;
}

export const TOOL_HUD: Record<ToolId, ToolHudEntry> = {
  // Edit mode's move gizmo + wall endpoint handles; both self-gate.
  select: { Scene: SelectEditScene },
  // Measure still carries its own bar inside its scene component (#5510
  // splits it into a Bar + Scene). Registered as the scene slot so it
  // renders exactly as before, without a bespoke branch in `ToolOverlays`.
  measure: { Scene: MeasureOverlay },
  // The Section bar (#5499); its hint is dynamic (pick / cut / off), so the
  // scene side renders it rather than this table's static `hint` key.
  section: { Bar: SectionToolbar, Scene: SectionOverlay },
  addElement: { Scene: AddElementOverlay },
  split: { Bar: SplitBar, Scene: SplitScene, hint: 'splitTool.hint' },
  spaceSketch: { Bar: SpaceSketchOverlay },
  annotate: {},
  'cesium-placement': {},
  'polygon-area': {},
  'appearance-face': {},
  cloud: {},
  text: {},
  walk: {},
  none: {},
};

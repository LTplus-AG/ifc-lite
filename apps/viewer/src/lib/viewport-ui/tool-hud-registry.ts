/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ComponentType } from 'react';

/**
 * `TOOL_HUD` registry (#5485, charter #5478 item 3).
 *
 * `ToolOverlays.tsx`'s `if (activeTool === …)` chain is meant to become a
 * table: a tool declares its bar, its scene layer and its hint, and the HUD
 * places them — so a new tool cannot invent its own `absolute` position the
 * way `SunSkyPanel` (`top-32 right-4`), `PointCloudPanel` (`bottom-4 left-4`)
 * and the rest do today. This ships the TYPE and an empty table; migrating
 * `ToolOverlays`' existing tools onto it is later items (#5478 §7/§8).
 *
 * `ToolId` is the closed set of `activeTool` string literals in use across
 * the viewer today (`store/slices/uiSlice.ts`'s `activeTool` is typed as a
 * plain `string`, so this is the first place that set is written down).
 * Every id gets a row, even an empty `{}` one, rather than making the table
 * `Partial`: a tool that has NOT declared a bar/scene/hint is still a
 * decision ("nothing here yet"), not an absence the table can't represent.
 */

const TOOL_IDS = [
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

export interface ToolHudEntry {
  /** The tool's bar, mounted in the HUD's top-center region while active. */
  Bar?: ComponentType;
  /** The tool's world-anchored scene overlay layer. */
  Scene?: ComponentType;
  /**
   * An i18n catalogue KEY (not literal text) for the HUD's bottom-center
   * hint line while this tool is active — resolved with `t(hint)` by
   * whichever component renders it into `HudHint`, so this table stays
   * locale-agnostic.
   */
  hint?: string;
}

/**
 * One row per `ToolId`. Empty today (`{}` for every tool) — no overlay has
 * been migrated onto the HUD yet.
 */
export const TOOL_HUD: Record<ToolId, ToolHudEntry> = Object.fromEntries(
  TOOL_IDS.map((id) => [id, {}]),
) as Record<ToolId, ToolHudEntry>;

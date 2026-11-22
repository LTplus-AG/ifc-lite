/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Every `activeTool` id, data only so audits can read it without the HUD components. */
export const TOOL_IDS = [
  'select',
  'measure',
  'section',
  'annotate',
  'cesium-placement',
  'polygon-area',
  'appearance-face',
  'cloud',
  'text',
  'walk',
  'command',
  'none',
] as const;

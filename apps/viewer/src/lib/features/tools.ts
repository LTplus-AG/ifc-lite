/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The viewport tools a host can switch off. `setActiveTool` asks
 * `isToolAvailable`, so no entry point (ribbon, palette, shortcut, tour,
 * script) can activate a tool that is off. Select is the baseline. The
 * authoring tools are not in TOOL_FEATURE: authoring is refused where edit
 * mode is entered, so they only need their commands and shortcuts gated.
 */

import { isFeatureEnabled, type FeatureId } from './index';

export const TOOL_FEATURE: Readonly<Record<string, FeatureId>> = {
  measure: 'tools.measure',
  section: 'tools.section',
  walk: 'tools.walk',
  annotate: 'tools.annotate',
};

/** The Model workspace's authoring tools: they go with editing. */
const MODEL_AUTHORING_TOOLS = [
  'wall', 'slab', 'roof', 'column', 'beam', 'room', 'space-envelope', 'curtain-wall', 'grid',
  'opening', 'door', 'window', 'split', 'stair', 'railing', 'split-multi', 'push-pull', 'align',
  'trim-extend', 'array', 'move', 'rotate',
] as const;

/** Every tool's feature keyed `${prefix}${tool}`: the tool rows of the command and shortcut tables. */
export function toolFeatureRows(prefix: string): Record<string, FeatureId> {
  return Object.fromEntries([
    ...Object.entries(TOOL_FEATURE),
    ...MODEL_AUTHORING_TOOLS.map((tool): [string, FeatureId] => [tool, 'edit.model']),
  ].map(([tool, feature]) => [`${prefix}${tool}`, feature]));
}

export function isToolAvailable(tool: string): boolean {
  const feature = Object.hasOwn(TOOL_FEATURE, tool) ? TOOL_FEATURE[tool] : undefined;
  return feature === undefined || isFeatureEnabled(feature);
}

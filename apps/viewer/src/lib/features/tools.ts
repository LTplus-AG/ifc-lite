/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The viewport tools a host can switch off. `setActiveTool` asks
 * `isToolAvailable`, so no entry point (ribbon, palette, shortcut, tour,
 * script) can activate a tool that is off. Select and the authoring tools
 * are not listed: Select is the baseline, and authoring is refused where
 * edit mode is entered.
 */

import { isFeatureEnabled, type FeatureId } from './index';

export const TOOL_FEATURE: Readonly<Record<string, FeatureId>> = {
  measure: 'tools.measure',
  section: 'tools.section',
  walk: 'tools.walk',
  annotate: 'tools.annotate',
};

/** TOOL_FEATURE keyed `${prefix}${tool}`: the tool rows of the command and shortcut tables. */
export function toolFeatureRows(prefix: string): Record<string, FeatureId> {
  return Object.fromEntries(Object.entries(TOOL_FEATURE).map(([tool, feature]) => [`${prefix}${tool}`, feature]));
}

export function isToolAvailable(tool: string): boolean {
  const feature = Object.hasOwn(TOOL_FEATURE, tool) ? TOOL_FEATURE[tool] : undefined;
  return feature === undefined || isFeatureEnabled(feature);
}

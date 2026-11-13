/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which registered commands this page offers (see `lib/features`).
 *
 * A command belongs to the feature named here, and a panel command also to
 * its panel's feature (`lib/panels/availability.ts`). A command with neither
 * is part of the baseline. Every projection of the registry (palette rows,
 * ribbon buttons, context-menu items, the mobile toolbar) asks
 * `isSurfaceCommandAvailable` and renders nothing for a command that is off.
 */

import { isFeatureEnabled, type FeatureId } from '@/lib/features';
import { toolFeatureRows } from '@/lib/features/tools';
import { isPanelAvailable } from '@/lib/panels/availability';
import type { SurfaceCommandDefinition } from './surface-command-types';
import { surfaceCommand, type SurfaceCommandId } from './surface-command-registry';

export const COMMAND_FEATURE: Readonly<Partial<Record<SurfaceCommandId, FeatureId>>> = {
  // `tool:<name>` rows come from TOOL_FEATURE, the one tool table.
  ...toolFeatureRows('tool:'),

  'view:lighting': 'view.environment',
  'vis:save-view': 'view.presentation',
  'vis:toggle-presentation': 'view.presentation',

  'schedule:generate': 'data.schedule',
  'schedule:toggle-animation': 'data.schedule',
  'schedule:reset': 'data.schedule',
};

/** Families of generated command ids (`measure:<mode>`, `section-add:<kind>`) belong to one feature. */
export const COMMAND_PREFIX_FEATURE: Readonly<Record<string, FeatureId>> = {
  'measure:': 'tools.measure',
  'measure-panel:': 'tools.measure',
  'section-add:': 'tools.section',
};

function commandFeature(id: string): FeatureId | undefined {
  const exact = (COMMAND_FEATURE as Partial<Record<string, FeatureId>>)[id];
  if (exact) return exact;
  const prefix = Object.keys(COMMAND_PREFIX_FEATURE).find((candidate) => id.startsWith(candidate));
  return prefix ? COMMAND_PREFIX_FEATURE[prefix] : undefined;
}

export function isSurfaceCommandAvailable(command: Pick<SurfaceCommandDefinition, 'id' | 'panelId'>): boolean {
  const feature = commandFeature(command.id);
  if (feature !== undefined && !isFeatureEnabled(feature)) return false;
  return command.panelId === undefined || isPanelAvailable(command.panelId);
}

/**
 * Whether a ribbon group built from `commands` shows anything. Tabs leave out
 * a group (and its divider) when none of its commands is available, decided
 * from the same table at render time.
 */
export function anyRibbonCommandAvailable(commands: readonly SurfaceCommandId[]): boolean {
  return commands.some((id) => isSurfaceCommandAvailable(surfaceCommand(id, 'ribbon')));
}

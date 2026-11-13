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
import { TOOL_FEATURE } from '@/lib/features/tools';
import { isPanelAvailable } from '@/lib/panels/availability';
import type { SurfaceCommandDefinition } from './surface-command-types';
import { surfaceCommand, type SurfaceCommandId } from './surface-command-registry';

/** A command with several features needs all of them on. */
export const COMMAND_FEATURE: Readonly<Partial<Record<SurfaceCommandId, FeatureId | readonly FeatureId[]>>> = {
  // `tool:<name>` rows come from TOOL_FEATURE, the one tool table.
  ...Object.fromEntries(Object.entries(TOOL_FEATURE).map(([tool, feature]) => [`tool:${tool}`, feature])),

  'view:lighting': 'view.environment',
  'vis:save-view': 'view.presentation',
  'vis:toggle-presentation': 'view.presentation',

  'schedule:generate': 'data.schedule',
  'schedule:toggle-animation': 'data.schedule',
  'schedule:reset': 'data.schedule',

  'file:open': 'files.local',
  'file:add-model': 'files.local',
  'file:refresh': 'files.local',
  'file:save-federation-setup': 'files.federation-setup',
  'file:open-federation-setup': 'files.federation-setup',

  'model:reposition': 'edit.placement',
  'view:move-georef': 'edit.placement',

  'file:new-blank': 'edit.model',
  'tool:edit-mode': 'edit.model',
  'tool:wall': 'edit.model',
  'tool:slab': 'edit.model',
  'tool:roof': 'edit.model',
  'tool:column': 'edit.model',
  'tool:beam': 'edit.model',
  'tool:room': 'edit.model',
  'tool:space-envelope': 'edit.model',
  'tool:curtain-wall': 'edit.model',
  'tool:grid': 'edit.model',
  'model:derive-structural': 'edit.model',
  'tool:opening': 'edit.model',
  'tool:door': 'edit.model',
  'tool:window': 'edit.model',
  'tool:split': 'edit.model',
  'tool:stair': 'edit.model',
  'tool:railing': 'edit.model',
  'tool:split-multi': 'edit.model',
  'tool:push-pull': 'edit.model',
  'tool:align': 'edit.model',
  'tool:trim-extend': 'edit.model',
  'tool:array': 'edit.model',
  'tool:move': 'edit.model',
  'tool:rotate': 'edit.model',
  'model:copy': 'edit.model',
  'model:paste': 'edit.model',
  'model:paste-in-place': 'edit.model',
  'model:storey-up': 'edit.model',
  'model:storey-down': 'edit.model',
  'model:exit': 'edit.model',
  'model:copy-to-storeys': 'edit.model',
  'model:plan': 'edit.model',
  'author:undo': 'edit.model',
  'author:redo': 'edit.model',
  'author:bulk-properties': 'edit.model',
  'author:import-data': 'edit.model',
  'context:duplicate': 'edit.model',
  'context:duplicate-x-plus': 'edit.model',
  'context:duplicate-x-minus': 'edit.model',
  'context:duplicate-y-plus': 'edit.model',
  'context:duplicate-y-minus': 'edit.model',
  'context:duplicate-z-plus': 'edit.model',
  'context:duplicate-z-minus': 'edit.model',
  'context:delete': 'edit.model',

  // Authoring an extension is done by the AI in chat.
  'extensions:author': ['automate.extensions', 'ai.assistant'],
  'extensions:flavors': 'automate.extensions',
  // The AI chat is a pane of the Script panel, so it needs scripting too.
  'panel:chat': 'ai.assistant',
  // The local agent bridge connects an AI agent; it opens from the Sources panel.
  'panel:agentBridge': 'ai.assistant',
  'file:share': 'collab.sessions',
  'settings:collaboration': 'collab.sessions',
  'context:export-anonymized': 'export.files',
  // 3D world context streams imagery and terrain from an outside service.
  'view:world': 'privacy.third-party',
  'learn:hub': 'help.tours',
};

/** Families of generated command ids (`measure:<mode>`, `section-add:<kind>`) belong to one feature. */
export const COMMAND_PREFIX_FEATURE: Readonly<Record<string, FeatureId>> = {
  'measure:': 'tools.measure',
  'measure-panel:': 'tools.measure',
  'section-add:': 'tools.section',
};

function commandFeatures(id: string): readonly FeatureId[] {
  const exact = (COMMAND_FEATURE as Partial<Record<string, FeatureId | readonly FeatureId[]>>)[id];
  if (exact) return typeof exact === 'string' ? [exact] : exact;
  const prefix = Object.keys(COMMAND_PREFIX_FEATURE).find((candidate) => id.startsWith(candidate));
  return prefix ? [COMMAND_PREFIX_FEATURE[prefix]] : [];
}

export function isSurfaceCommandAvailable(command: Pick<SurfaceCommandDefinition, 'id' | 'panelId'>): boolean {
  if (!commandFeatures(command.id).every(isFeatureEnabled)) return false;
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

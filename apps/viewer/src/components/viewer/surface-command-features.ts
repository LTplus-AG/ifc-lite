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

/** A command with several features needs all of them on. */
export const COMMAND_FEATURE: Readonly<Partial<Record<SurfaceCommandId, FeatureId | readonly FeatureId[]>>> = {
  // `tool:<name>` rows, the authoring tools included, come from `lib/features/tools`.
  ...toolFeatureRows('tool:'),

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
  // Georeferencing is written into the model, so it needs editing too.
  'view:move-georef': ['edit.placement', 'edit.model'],

  'file:new-blank': 'edit.model',
  'tool:edit-mode': 'edit.model',
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
  // Tours load the sample project (`isTourAvailable`).
  'learn:hub': ['help.tours', 'files.samples'],
};

/** Families of command ids (`measure:<mode>`, every `model:` command) belong to one feature; an exact row above wins. */
export const COMMAND_PREFIX_FEATURE: Readonly<Record<string, FeatureId>> = {
  'measure:': 'tools.measure',
  'measure-panel:': 'tools.measure',
  'section-add:': 'tools.section',
  'model:': 'edit.model',
  'author:': 'edit.model',
  'context:duplicate': 'edit.model',
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

/** The AI chat is a pane of the Script panel, so it needs both `ai.assistant` and scripting. */
export function isAiChatAvailable(): boolean {
  return isSurfaceCommandAvailable(surfaceCommand('panel:chat', 'palette'));
}

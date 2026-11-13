/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which keyboard commands this page registers (see `lib/features`).
 *
 * A command belongs to a feature by its id, or else by the context it fires
 * in: every key that only works while the Walk tool is open belongs to Walk.
 * `registerKeyboardCommand` asks `isKeyCommandAvailable` and registers
 * nothing for a command that is off; the shortcuts dialog lists the same set.
 */

import { isFeatureEnabled, type FeatureId } from '@/lib/features';
import { TOOL_FEATURE } from '@/lib/features/tools';
import type { KeyCommandDefinition, KeyCommandId, KeyContext } from './keyboard-commands';

export const KEY_COMMAND_FEATURE: Readonly<Partial<Record<KeyCommandId, FeatureId>>> = {
  // `tool.<name>` rows come from TOOL_FEATURE, the one tool table.
  ...Object.fromEntries(Object.entries(TOOL_FEATURE).map(([tool, feature]) => [`tool.${tool}`, feature])),
  'edit.toggleEditMode': 'edit.model',
  'edit.rotate': 'edit.model',
  'edit.duplicate': 'edit.model',
  'tool.split': 'edit.model',
  'basket.toggleDock': 'view.presentation',
  'basket.saveView': 'view.presentation',
};

/** Contexts owned by one feature. A `command.<id>` context counts as `command`. */
export const KEY_CONTEXT_FEATURE: Readonly<Partial<Record<KeyContext, FeatureId>>> = {
  // A tool's own key context belongs to the tool (TOOL_FEATURE).
  ...Object.fromEntries(Object.entries(TOOL_FEATURE).map(([tool, feature]) => [`tool.${tool}`, feature])),
  command: 'edit.model',
  'workspace.model': 'edit.model',
  'panel.reposition': 'edit.placement',
  'panel.schedule': 'data.schedule',
  'schedule.drag': 'data.schedule',
  'panel.script': 'automate.scripting',
  'panel.chat': 'ai.assistant',
  drawing2d: 'view.drawings',
};

export function isKeyCommandAvailable(command: Pick<KeyCommandDefinition, 'id' | 'when'>): boolean {
  const context: KeyContext = command.when.startsWith('command.') ? 'command' : command.when;
  const feature = (KEY_COMMAND_FEATURE as Partial<Record<string, FeatureId>>)[command.id] ?? KEY_CONTEXT_FEATURE[context];
  return feature === undefined || isFeatureEnabled(feature);
}

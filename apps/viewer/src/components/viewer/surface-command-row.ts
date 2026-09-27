/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { resolveEnglish } from '@/i18n/registry';
import type { Command } from './commandPaletteSearch';
import { runSurfaceCommand } from './surface-command-run';
import type { SurfaceCommandContext, SurfaceCommandDefinition } from './surface-commands';

/** One row projection for the palette and mobile command menus. */
export function commandRowFromDefinition(
  command: SurfaceCommandDefinition,
  context: SurfaceCommandContext,
): Command {
  return {
    id: command.id,
    label: command.searchLabel ?? resolveEnglish(command.labelKey),
    labelKey: command.labelKey,
    keywords: command.keywords,
    category: command.category,
    icon: command.icon,
    shortcut: command.shortcut,
    immediate: command.immediate,
    registryOwned: true,
    action: () => runSurfaceCommand(command, context),
  };
}

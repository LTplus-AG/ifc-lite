/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Ctrl/Cmd+K command palette's full command table (#4918 slice 3) —
 * composes `commandPaletteCommandsCore.ts` (File/View/Tools/Visibility)
 * and `commandPaletteCommandsPanels.ts` (Panels/Schedule/Export/Automation/
 * Preferences/Learn/Extensions). Split three ways, rather than left as one
 * ~430-line table, so no single file needs a `scripts/module-size-allowlist.txt`
 * row; see the core file's docblock for the full rationale and the
 * `labelKey`/`label` convention both halves follow.
 */

import type { Command } from './commandPaletteSearch';
import type { CommandPaletteBuildParams } from './commandPaletteCommandsTypes';
import { buildCoreCommands } from './commandPaletteCommandsCore';
import { buildPanelCommands } from './commandPaletteCommandsPanels';

export type { CommandPaletteBuildParams, RightPanel } from './commandPaletteCommandsTypes';

export function buildCommandPaletteCommands(p: CommandPaletteBuildParams): Command[] {
  return [...buildCoreCommands(p), ...buildPanelCommands(p)];
}

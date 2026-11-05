/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Static definitions project once with the full mounted context (#8947).
 * Runtime providers retain their category and provider order independently. */

import { CATEGORY_ORDER, type Command } from './commandPaletteSearch';
import type { CommandPaletteBuildParams } from './commandPaletteCommandsTypes';
import { isCollabEnabled } from '@/lib/collab/config';
import { paletteSurfaceCommands } from './surface-commands';
import { buildCoreCommands } from './commandPaletteCommandsCore';
import { buildPanelCommands } from './commandPaletteCommandsPanels';

export type { CommandPaletteBuildParams, RightPanel } from './commandPaletteCommandsTypes';

export function buildCommandPaletteCommands(p: CommandPaletteBuildParams): Command[] {
  const shared = paletteSurfaceCommands({ canEditInSession: p.canEditInSession,
    cesiumAvailable: p.cesiumAvailable, collabEnabled: isCollabEnabled() }, p.execute,
  { ...p.surfaceContext, activateRightPanel: p.activateRightPanel,
    activateBottomPanel: p.activateBottomPanel, runExport: p.runExport });
  const runtime = [...buildCoreCommands(p), ...buildPanelCommands(p)];
  // Preserve provider order inside each category, including tours before Learn.
  // Every static row is consumed by category, regardless of its id family.
  return CATEGORY_ORDER.flatMap(category => {
    const fixed = shared.filter(command => command.category === category);
    const provided = runtime.filter(command => command.category === category);
    if (category === 'Visibility') fixed.sort((a, b) =>
      Number(a.id === 'schedule:toggle-animation') - Number(b.id === 'schedule:toggle-animation'));
    return category === 'Learn' ? [...provided, ...fixed] : [...fixed, ...provided];
  });
}

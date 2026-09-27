/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Ctrl/Cmd+K command palette's File/View/Tools/Visibility commands
 * (#4918 slice 3) — the first half of the table split out of
 * `CommandPalette.tsx`; `commandPaletteCommandsPanels.ts` is the rest, and
 * `commandPaletteCommands.ts` composes both. Splitting the table out is
 * what keeps `CommandPalette.tsx` under its
 * `scripts/module-size-allowlist.txt` budget once every static label
 * carries a `labelKey` (`command-palette.en.ts`) instead of a literal.
 *
 * Every row that shows fixed UI copy carries `labelKey` (via `withKey`);
 * the component calls `t()` at render. `label` stays the English text
 * search ranks against (`rankCommand` in `commandPaletteSearch.ts`) — kept
 * because search matches the literal typed query, independent of locale.
 * The recent-files loop has no `labelKey`: the filename IS the label.
 */

import { FolderOpen, Clock } from 'lucide-react';
import { formatFileSize, getCachedFile } from '@/lib/recent-files';
import type { Command } from './commandPaletteSearch';
import { withKey, type CommandPaletteBuildParams } from './commandPaletteCommandsTypes';
import { paletteSurfaceCommands } from './surface-commands';

export function buildCoreCommands(p: CommandPaletteBuildParams): Command[] {
  const c: Command[] = [];
  const shared = paletteSurfaceCommands({ canEditInSession: p.canEditInSession, cesiumAvailable: p.cesiumAvailable }, p.execute);

  // ── File ──
  c.push(
    { id: 'file:open', label: 'Open File', ...withKey('commandPalette.file.open.label'), keywords: 'ifc ifcx glb load model browse', category: 'File', icon: FolderOpen,
      immediate: true,
      action: () => { window.dispatchEvent(new CustomEvent('ifc-lite:open-files')); } },
    ...shared.filter((command) => command.category === 'File'),
  );
  for (const rf of p.recentFiles) {
    const fileName = rf.name;
    c.push({
      id: `file:recent:${fileName}`, label: fileName,
      keywords: `recent open ${formatFileSize(rf.size)}`,
      category: 'File', icon: Clock,
      detail: formatFileSize(rf.size),
      immediate: true,
      action: () => {
        if (p.cachedNames.current.has(fileName)) {
          void getCachedFile(rf).then(file => {
            if (file) window.dispatchEvent(new CustomEvent('ifc-lite:load-file', { detail: file }));
            else window.dispatchEvent(new CustomEvent('ifc-lite:open-files'));
          });
        } else {
          window.dispatchEvent(new CustomEvent('ifc-lite:open-files'));
        }
      },
    });
  }

  // ── View ── (static rows are generated from the shared table)
  c.push(...shared.filter((command) => command.category === 'View'));

  // ── Tools ── (static rows are generated from the shared table)
  c.push(...shared.filter((command) => command.id.startsWith('tool:') || command.id === 'model:reposition'));

  // ── Visibility ── (static rows are generated from the shared table)
  c.push(...shared.filter((command) => command.id.startsWith('vis:')));

  return c;
}

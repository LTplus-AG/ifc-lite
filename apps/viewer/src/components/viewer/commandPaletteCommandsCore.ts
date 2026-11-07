/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Runtime recent-file provider. Static definitions are projected once by the composer. */

import { Clock } from 'lucide-react';
import { formatFileSize, getCachedFile } from '@/lib/recent-files';
import type { Command } from './commandPaletteSearch';
import type { CommandPaletteBuildParams } from './commandPaletteCommandsTypes';

export function buildCoreCommands(p: CommandPaletteBuildParams): Command[] {
  const c: Command[] = [];

  // ── File ──
  for (const rf of p.recentFiles) {
    const fileName = rf.name;
    c.push({
      id: `file:recent:${fileName}`, label: fileName,
      runtimeSource: 'recent-file',
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




  return c;
}

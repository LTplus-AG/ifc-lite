/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Runtime recent-file provider. Static definitions are projected once by the composer. */

import { paletteAvailability } from './palette-availability';
import { surfaceCommand } from './surface-commands';
import { resolve as t } from '@/i18n/registry';
import { toast } from '@/components/ui/toast';
import { Clock } from 'lucide-react';
import { formatFileSize, getCachedFile } from '@/lib/recent-files';
import type { Command } from './commandPaletteSearch';
import type { CommandPaletteBuildParams } from './commandPaletteCommandsTypes';

export function buildCoreCommands(p: CommandPaletteBuildParams): Command[] {
  const c: Command[] = [];
  const checkAvailability = () => paletteAvailability(surfaceCommand('file:open', 'palette'),
    { ...p.surfaceContext, surface: 'palette' });

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
      availability: checkAvailability(), checkAvailability,
      action: () => {
        if (p.cachedNames.current.has(fileName)) {
          void getCachedFile(rf).then(file => {
            if (checkAvailability().status !== 'available') return;
            if (file) window.dispatchEvent(new CustomEvent('ifc-lite:load-file', { detail: file }));
            else toast.info(t('commandPalette.availability.reopen'));
          }).catch(error => {
            console.error('[CommandPalette] Recent file load failed', error);
            toast.error(error instanceof Error ? error.message : String(error));
          });
        } else {
          p.surfaceContext?.openFiles?.();
        }
      },
    });
  }




  return c;
}

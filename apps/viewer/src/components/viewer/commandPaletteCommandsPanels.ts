/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Runtime export, automation, tour and extension providers, in their established order. */

import { Play, GraduationCap } from 'lucide-react';
import { useViewerStore } from '@/store';
import { resolveExtensionIcon } from '@/components/extensions/icon-registry';
import { toast as paletteToast } from '@/components/ui/toast';
import { SCRIPT_TEMPLATES } from '@/lib/scripts/templates';
import { TOUR_REGISTRY } from '@/lib/tours/registry';
import { startTour } from '@/lib/tours/controller';
import { buildExportCommands } from './commandPaletteExports';
import { describeRunCommandError } from '@/services/extensions/runtime-errors';
import type { Command } from './commandPaletteSearch';
import type { PaletteAvailability } from './palette-availability';
import { withKey, type CommandPaletteBuildParams } from './commandPaletteCommandsTypes';

export function buildPanelCommands(p: CommandPaletteBuildParams): Command[] {
  const c: Command[] = [];



  // ── Export ── (built from the toolbar registry, #5601)
  c.push(...buildExportCommands(p.runExport, p.extensionExporters));

  // ── Automation (scripts — last, power-user feature) ──
  for (const t of SCRIPT_TEMPLATES) {
    c.push({
      id: `auto:${t.name}`, label: t.name, keywords: `script run ${t.description}`,
      runtimeSource: 'script-template',
      category: 'Automation', icon: Play,
      action: () => { const s = useViewerStore.getState(); s.setListPanelVisible(false); s.setScriptPanelVisible(true); s.setScriptEditorContent(t.code); p.execute(t.code); },
    });
  }

  // ── Learn (tours) ──
  for (const tour of TOUR_REGISTRY) {
    c.push({
      id: `tour:${tour.id}`,
      runtimeSource: 'tour',
      label: `Tour: ${tour.title}`,
      ...withKey('commandPalette.tour.label', { title: tour.title }),
      keywords: `tour walkthrough learn guide tutorial onboarding ${tour.description}`,
      category: 'Learn',
      icon: GraduationCap,
      detail: `${tour.minutes} min`,
      detailKey: 'commandPalette.tour.minutes',
      detailKeyParams: { minutes: tour.minutes },
      action: () => { startTour(tour.id, 'palette'); },
    });
  }

  // ── Extension contributions ──
  for (const contribution of p.extensionCommands) {
    const payload = contribution.payload;
    if (!payload?.id || !payload.title) continue;
    const checkAvailability = (): PaletteAvailability => {
      if (!p.extensionHost || p.extensionHostIsCurrent?.() === false) {
        return { status: 'disabled', reasonKey: 'commandPalette.availability.host' };
      }
      if (!p.extensionHost.slotRegistry.getAll('commandPalette').includes(contribution)) {
        return { status: 'disabled', reasonKey: 'commandPalette.availability.feature' };
      }
      return { status: 'available' };
    };
    c.push({
      id: `ext:${payload.id}`,
      availability: checkAvailability(),
      checkAvailability,
      runtimeSource: 'extension-command',
      label: payload.title,
      keywords: `${payload.id} ${payload.paletteCategory ?? ''} extension`,
      category: 'Extensions',
      icon: resolveExtensionIcon(payload.icon),
      detail: payload.paletteCategory,
      action: () => {
        if (checkAvailability().status === 'disabled' || !p.extensionHost) return;
        void p.extensionHost.dispatcher
          .fire(`onCommand:${payload.id}` as `onCommand:${string}`)
          .then(() => p.extensionHost?.runCommand(payload.id, contribution.extensionId))
          .catch((err: unknown) => {
            paletteToast.error(describeRunCommandError(payload.id, err));
          });
      },
    });
  }

  return c;
}

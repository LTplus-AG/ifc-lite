/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Ctrl/Cmd+K command palette's Panels/Schedule/Export/Automation/
 * Preferences/Learn/Extensions commands (#4918 slice 3) — the second half
 * of the table split out of `CommandPalette.tsx`; `commandPaletteCommandsCore.ts`
 * holds File/View/Tools/Visibility, and `commandPaletteCommands.ts` composes
 * both. See that core file's docblock for why the split exists and the
 * `labelKey`/`label` convention every row below follows.
 *
 * Deliberately NOT catalogued (see `command-palette.en.ts`'s docblock):
 * script-template rows (`auto:*`, user-authored automation content), tour
 * titles from `TOUR_REGISTRY` (only the "Tour: " wrapper and "{minutes} min"
 * detail are catalogued), and extension-contributed rows (`ext:*`,
 * `payload.title` sourced from the extension registry at runtime).
 */

import { Play, GraduationCap } from 'lucide-react';
import { isCollabEnabled } from '@/lib/collab/config';
import { useViewerStore } from '@/store';
import { resolveExtensionIcon } from '@/components/extensions/icon-registry';
import { toast as paletteToast } from '@/components/ui/toast';
import { SCRIPT_TEMPLATES } from '@/lib/scripts/templates';
import { TOUR_REGISTRY } from '@/lib/tours/registry';
import { startTour } from '@/lib/tours/controller';
import { buildExportCommands } from './commandPaletteExports';
import { describeRunCommandError } from '@/services/extensions/runtime-errors';
import type { Command } from './commandPaletteSearch';
import { withKey, type CommandPaletteBuildParams } from './commandPaletteCommandsTypes';
import { paletteSurfaceCommands } from './surface-commands';

export function buildPanelCommands(p: CommandPaletteBuildParams): Command[] {
  const c: Command[] = [];
  const shared = paletteSurfaceCommands(
    { canEditInSession: p.canEditInSession, cesiumAvailable: p.cesiumAvailable, collabEnabled: isCollabEnabled() },
    p.execute,
    { activateRightPanel: p.activateRightPanel, activateBottomPanel: p.activateBottomPanel },
  );

  // ── Panels ── (static panel rows come from the shared command table)
  c.push(...shared.filter((command) => command.id.startsWith('panel:')));
  c.push(...shared.filter((command) => command.id.startsWith('extensions:') || command.id.startsWith('sidebar:')));

  // ── Schedule / 4D (Tools) ─────────────────────────────
  c.push(...shared.filter((command) => command.id.startsWith('schedule:')));

  // ── Export ── (built from the toolbar registry, #5601)
  c.push(...buildExportCommands(p.runExport, p.extensionExporters));

  // ── Automation (scripts — last, power-user feature) ──
  for (const t of SCRIPT_TEMPLATES) {
    c.push({
      id: `auto:${t.name}`, label: t.name, keywords: `script run ${t.description}`,
      category: 'Automation', icon: Play,
      action: () => { const s = useViewerStore.getState(); s.setListPanelVisible(false); s.setScriptPanelVisible(true); s.setScriptEditorContent(t.code); p.execute(t.code); },
    });
  }

  // ── Preferences ──
  c.push(...shared.filter((command) => command.id.startsWith('pref:')));

  // ── Learn (tours) ──
  for (const tour of TOUR_REGISTRY) {
    c.push({
      id: `tour:${tour.id}`,
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
  c.push(...shared.filter((command) => command.id === 'learn:hub'));

  // ── Extension contributions ──
  for (const contribution of p.extensionCommands) {
    const payload = contribution.payload;
    if (!payload?.id || !payload.title) continue;
    c.push({
      id: `ext:${payload.id}`,
      label: payload.title,
      keywords: `${payload.id} ${payload.paletteCategory ?? ''} extension`,
      category: 'Extensions',
      icon: resolveExtensionIcon(payload.icon),
      detail: payload.paletteCategory,
      action: () => {
        if (!p.extensionHost) return;
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

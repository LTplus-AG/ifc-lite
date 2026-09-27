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

import {
  Play, Palette, Sun, Info, Settings, CalendarPlus, Sparkles, Eraser,
  GraduationCap, PanelRight, SlidersHorizontal, ChevronsRight, RotateCcw,
} from 'lucide-react';
import { isCollabEnabled } from '@/lib/collab/config';
import { openSettings } from '@/lib/settings/open-settings';
import { useViewerStore } from '@/store';
import { resetLayout } from '@/store/layoutReset';
import { resolveExtensionIcon } from '@/components/extensions/icon-registry';
import { toast as paletteToast } from '@/components/ui/toast';
import { SCRIPT_TEMPLATES } from '@/lib/scripts/templates';
import { TOUR_REGISTRY } from '@/lib/tours/registry';
import { startTour } from '@/lib/tours/controller';
import { EVENT_SHOW_SHORTCUTS } from '@/lib/tours/events';
import { buildExportCommands } from './commandPaletteExports';
import { describeRunCommandError } from '@/services/extensions/runtime-errors';
import type { Command } from './commandPaletteSearch';
import { withKey, type CommandPaletteBuildParams } from './commandPaletteCommandsTypes';
import { paletteSurfaceCommands } from './surface-commands';

export function buildPanelCommands(p: CommandPaletteBuildParams): Command[] {
  const c: Command[] = [];

  // ── Panels ── (static panel rows come from the shared command table)
  c.push(...paletteSurfaceCommands(
    { canEditInSession: p.canEditInSession, cesiumAvailable: p.cesiumAvailable, collabEnabled: isCollabEnabled() },
    p.execute,
    { activateRightPanel: p.activateRightPanel, activateBottomPanel: p.activateBottomPanel },
  ).filter((command) => command.id.startsWith('panel:')));
  c.push(
    { id: 'extensions:author', label: 'Author an extension…', ...withKey('commandPalette.tool.extensionsAuthor.label'),
      keywords: 'create new build plan chat ai extension generate',
      category: 'Tools', icon: Sparkles,
      action: () => {
        const s = useViewerStore.getState();
        p.activateRightPanel('extensions');
        s.setExtensionsRequestedView('ideas');
        s.setIdeasOpenEmptyPlan(true);
      } },
    { id: 'extensions:flavors', label: 'Manage flavors…', ...withKey('commandPalette.panel.flavors.label'),
      keywords: 'flavor profile switch export import merge customization',
      category: 'Panels', icon: Palette,
      action: () => {
        useViewerStore.getState().setFlavorDialogRequested(true);
      } },
    { id: 'sidebar:toggle', label: 'Toggle Sidebar', ...withKey('commandPalette.sidebar.toggle.label'), keywords: 'sidebar panels show hide off optional workspace', category: 'Panels', icon: PanelRight, shortcut: 'ui.toggleSidebar',
      action: () => { useViewerStore.getState().toggleSidebar(); } },
    { id: 'sidebar:collapse', label: 'Collapse Sidebar to Icons', ...withKey('commandPalette.sidebar.collapse.label'), keywords: 'sidebar collapse icons rail minimize', category: 'Panels', icon: ChevronsRight,
      action: () => { useViewerStore.getState().setSidebarMode('collapsed'); } },
    { id: 'sidebar:customize', label: 'Customize Sidebar…', ...withKey('commandPalette.sidebar.customize.label'), keywords: 'sidebar customize reorder hide show panels edit arrange', category: 'Panels', icon: SlidersHorizontal,
      action: () => { const s = useViewerStore.getState(); s.setSidebarMode('expanded'); s.setSidebarCustomizing(true); } },
    { id: 'sidebar:reset', label: 'Reset Layout', ...withKey('commandPalette.sidebar.reset.label'), keywords: 'layout sidebar floating panels reset default order width restore', category: 'Panels', icon: RotateCcw,
      action: () => { resetLayout(); } },
  );

  // ── Schedule / 4D (Tools) ─────────────────────────────
  c.push(
    { id: 'schedule:generate', label: 'Generate Schedule from Storeys…', ...withKey('commandPalette.schedule.generate.label'),
      keywords: '4d ifctask construction sequence storey building create gantt',
      category: 'Tools', icon: CalendarPlus,
      action: () => {
        const s = useViewerStore.getState();
        if (!s.ganttPanelVisible) p.activateBottomPanel('gantt');
        useViewerStore.getState().setGenerateScheduleDialogOpen(true);
      } },
    { id: 'schedule:toggle-animation', label: 'Toggle 4D Construction Animation', ...withKey('commandPalette.schedule.toggleAnimation.label'),
      keywords: 'play pause schedule task gantt simulation',
      category: 'Visibility', icon: Sparkles,
      action: () => {
        const s = useViewerStore.getState();
        s.setAnimationEnabled(!s.animationEnabled);
      } },
    { id: 'schedule:reset', label: 'Reset Schedule (Clear 4D Data)', ...withKey('commandPalette.schedule.reset.label'),
      keywords: 'remove gantt tasks ifctask delete clear',
      category: 'Tools', icon: Eraser,
      action: () => {
        const s = useViewerStore.getState();
        s.setScheduleData(null);
        s.setAnimationEnabled(false);
        s.pauseSchedule();
      } },
  );

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
  c.push(
    { id: 'pref:theme', label: 'Theme', ...withKey('commandPalette.pref.theme.label'), keywords: 'dark light mode appearance switch', category: 'Preferences', icon: Sun, shortcut: 'ui.toggleTheme',
      action: () => { useViewerStore.getState().toggleTheme(); } },
    { id: 'pref:tooltips', label: 'Hover Tooltips', ...withKey('commandPalette.pref.tooltips.label'), keywords: 'entity info mouse hover show hide', category: 'Preferences', icon: Info,
      action: () => { useViewerStore.getState().toggleHoverTooltips(); } },
    { id: 'pref:settings', label: 'Settings…', ...withKey('commandPalette.pref.settings.label'), keywords: 'settings preferences options configure theme toolbar spacemouse', category: 'Preferences', icon: Settings,
      action: () => { openSettings(); } },
  );

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
  c.push({
    id: 'learn:hub',
    label: 'Open Learn Hub',
    ...withKey('commandPalette.learn.hub.label'),
    keywords: 'tour walkthrough learn tutorials help getting started onboarding',
    category: 'Learn',
    icon: GraduationCap,
    action: () => { window.dispatchEvent(new CustomEvent(EVENT_SHOW_SHORTCUTS, { detail: { tab: 'learn' } })); },
  });

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

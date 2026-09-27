/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Static workspace, schedule, preference, and help commands (#5870). */
import {
  CalendarPlus, ChevronsRight, Eraser, GraduationCap, Info, Palette,
  PanelRight, RotateCcw, Settings, SlidersHorizontal, Sparkles, Sun,
} from 'lucide-react';
import { EVENT_SHOW_SHORTCUTS } from '@/lib/tours/events';
import { openSettings } from '@/lib/settings/open-settings';
import { resetLayout } from '@/store/layoutReset';
import { useViewerStore } from '@/store';
import type { SurfaceCommandContext, SurfaceCommandDefinition, SurfaceCommandState } from './surface-commands';

const paletteOnly = ['palette'] as const;
const paletteAndRibbon = ['palette', 'ribbon'] as const;
const alwaysEnabled = (_state: SurfaceCommandState): boolean => true;

export const WORKSPACE_SURFACE_COMMANDS = [
  {
    id: 'extensions:author', labelKey: 'commandPalette.tool.extensionsAuthor.label',
    keywords: 'create new build plan chat ai extension generate',
    category: 'Tools', icon: Sparkles, surfaces: paletteOnly, enabled: alwaysEnabled,
    run: (context: SurfaceCommandContext) => {
      if (!context.activateRightPanel) throw new Error('Cannot author an extension without a panel host');
      const state = useViewerStore.getState();
      context.activateRightPanel('extensions');
      state.setExtensionsRequestedView('ideas');
      state.setIdeasOpenEmptyPlan(true);
    },
  },
  {
    id: 'extensions:flavors', labelKey: 'commandPalette.panel.flavors.label',
    searchLabel: 'Manage flavors…',
    keywords: 'flavor profile switch export import merge customization',
    category: 'Panels', icon: Palette, surfaces: paletteOnly, enabled: alwaysEnabled,
    run: () => { useViewerStore.getState().setFlavorDialogRequested(true); },
  },
  {
    id: 'sidebar:toggle', labelKey: 'commandPalette.sidebar.toggle.label',
    keywords: 'sidebar panels show hide off optional workspace',
    category: 'Panels', icon: PanelRight, shortcut: 'ui.toggleSidebar',
    surfaces: paletteOnly, enabled: alwaysEnabled,
    run: () => { useViewerStore.getState().toggleSidebar(); },
  },
  {
    id: 'sidebar:collapse', labelKey: 'commandPalette.sidebar.collapse.label',
    keywords: 'sidebar collapse icons rail minimize',
    category: 'Panels', icon: ChevronsRight, surfaces: paletteOnly, enabled: alwaysEnabled,
    run: () => { useViewerStore.getState().setSidebarMode('collapsed'); },
  },
  {
    id: 'sidebar:customize', labelKey: 'commandPalette.sidebar.customize.label',
    keywords: 'sidebar customize reorder hide show panels edit arrange',
    category: 'Panels', icon: SlidersHorizontal, surfaces: paletteOnly, enabled: alwaysEnabled,
    run: () => {
      const state = useViewerStore.getState();
      state.setSidebarMode('expanded');
      state.setSidebarCustomizing(true);
    },
  },
  {
    id: 'sidebar:reset', labelKey: 'commandPalette.sidebar.reset.label',
    keywords: 'layout sidebar floating panels reset default order width restore',
    category: 'Panels', icon: RotateCcw, surfaces: paletteOnly, enabled: alwaysEnabled,
    run: () => { resetLayout(); },
  },
  {
    id: 'schedule:generate', labelKey: 'commandPalette.schedule.generate.label',
    keywords: '4d ifctask construction sequence storey building create gantt',
    category: 'Tools', icon: CalendarPlus, surfaces: paletteOnly, enabled: alwaysEnabled,
    run: (context: SurfaceCommandContext) => {
      if (!context.activateBottomPanel) throw new Error('Cannot generate a schedule without a panel host');
      const state = useViewerStore.getState();
      if (!state.ganttPanelVisible) context.activateBottomPanel('gantt');
      useViewerStore.getState().setGenerateScheduleDialogOpen(true);
    },
  },
  {
    id: 'schedule:toggle-animation', labelKey: 'commandPalette.schedule.toggleAnimation.label',
    keywords: 'play pause schedule task gantt simulation',
    category: 'Visibility', icon: Sparkles, surfaces: paletteOnly, enabled: alwaysEnabled,
    run: () => {
      const state = useViewerStore.getState();
      state.setAnimationEnabled(!state.animationEnabled);
    },
  },
  {
    id: 'schedule:reset', labelKey: 'commandPalette.schedule.reset.label',
    keywords: 'remove gantt tasks ifctask delete clear',
    category: 'Tools', icon: Eraser, surfaces: paletteOnly, enabled: alwaysEnabled,
    run: () => {
      const state = useViewerStore.getState();
      state.setScheduleData(null);
      state.setAnimationEnabled(false);
      state.pauseSchedule();
    },
  },
  {
    id: 'pref:theme', labelKey: 'commandPalette.pref.theme.label',
    keywords: 'dark light mode appearance switch',
    category: 'Preferences', icon: Sun, shortcut: 'ui.toggleTheme',
    surfaces: paletteOnly, enabled: alwaysEnabled,
    run: () => { useViewerStore.getState().toggleTheme(); },
  },
  {
    id: 'pref:tooltips', labelKey: 'commandPalette.pref.tooltips.label', ribbonLabelKey: 'ribbon.elements.hoverTips', ribbonTooltipKey: 'ribbon.elements.hoverTipsTooltip',
    keywords: 'entity info mouse hover show hide',
    category: 'Preferences', icon: Info, surfaces: paletteAndRibbon, enabled: alwaysEnabled,
    run: () => { useViewerStore.getState().toggleHoverTooltips(); },
  },
  {
    id: 'pref:settings', labelKey: 'commandPalette.pref.settings.label', ribbonLabelKey: 'ribbon.view.settings', ribbonTooltipKey: 'ribbon.view.settingsTooltip',
    keywords: 'settings preferences options configure theme toolbar spacemouse',
    category: 'Preferences', icon: Settings, surfaces: paletteAndRibbon, enabled: alwaysEnabled,
    run: () => { openSettings(); },
  },
  {
    id: 'learn:hub', labelKey: 'commandPalette.learn.hub.label',
    keywords: 'tour walkthrough learn tutorials help getting started onboarding',
    category: 'Learn', icon: GraduationCap, surfaces: paletteOnly, enabled: alwaysEnabled,
    run: () => { window.dispatchEvent(new CustomEvent(EVENT_SHOW_SHORTCUTS, { detail: { tab: 'learn' } })); },
  },
] as const satisfies readonly SurfaceCommandDefinition[];

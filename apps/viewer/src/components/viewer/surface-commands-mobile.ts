/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Fixed mobile commands without a palette row. File inputs remain DOM-owned. */
import { Eye, Moon, Plus, Search, Sun } from 'lucide-react';
import { emitOpenCommandPalette } from '@/lib/tours/events';
import { executeBasketIsolate } from '@/store/basket/basketCommands';
import { useViewerStore } from '@/store';
import type { SurfaceCommandContext, SurfaceCommandDefinition, SurfaceCommandState } from './surface-commands';

const mobileOnly = ['mobile'] as const;
const mobileAndRibbon = ['mobile', 'ribbon'] as const;
const alwaysEnabled = (_state: SurfaceCommandState): boolean => true;

export const MOBILE_SURFACE_COMMANDS = [
  {
    id: 'file:add-model', labelKey: 'shellChrome.mobileToolbar.addModelAriaLabel', ribbonLabelKey: 'ribbon.file.addModel', ribbonTooltipKey: 'ribbon.file.addModelTooltip',
    keywords: 'add load federated model', category: 'File', icon: Plus,
    surfaces: mobileAndRibbon, enabled: alwaysEnabled,
    run: ({ addModel }: SurfaceCommandContext) => {
      if (!addModel) throw new Error('Add model requires the mobile file input');
      addModel();
    },
  },
  {
    id: 'ui:commands', labelKey: 'shellChrome.mobileToolbar.commands',
    keywords: 'search commands palette', category: 'Tools', icon: Search,
    surfaces: mobileOnly, enabled: alwaysEnabled,
    run: () => { emitOpenCommandPalette(); },
  },
  {
    id: 'vis:isolate', labelKey: 'shellChrome.mobileToolbar.isolateSelection', ribbonLabelKey: 'ribbon.elements.isolate', ribbonTooltipKey: 'ribbon.elements.isolateTooltip',
    keywords: 'isolate selected collection', category: 'Visibility', icon: Eye,
    surfaces: mobileAndRibbon, enabled: alwaysEnabled, shortcut: 'basket.isolate',
    run: () => { executeBasketIsolate(); },
  },
  {
    id: 'view:theme', labelKey: 'shellChrome.mobileToolbar.darkMode',
    keywords: 'dark light theme appearance', category: 'View', icon: Moon,
    surfaces: mobileOnly, enabled: alwaysEnabled,
    mobileLabelKey: (state: SurfaceCommandState) => state.theme === 'dark'
      ? 'shellChrome.mobileToolbar.lightMode' : 'shellChrome.mobileToolbar.darkMode',
    mobileIcon: (state: SurfaceCommandState) => state.theme === 'dark' ? Sun : Moon,
    run: () => { useViewerStore.getState().toggleTheme(); },
  },
] as const satisfies readonly SurfaceCommandDefinition[];

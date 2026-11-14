/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Mounted Elements controls with no palette or mobile equivalent. */
import { Ellipsis, Filter, Layers3, Search } from 'lucide-react';
import { useViewerStore, type HierarchyMode } from '@/store';
import { openSelectedEntityActions } from './selected-entity-actions';
import { focusInlineSearch } from './inline-search-focus';
import { liftStartFold } from './welcome/useEmptyStartFold';
import type { SurfaceCommandDefinition, SurfaceCommandState } from './surface-commands';

const paletteAndRibbon = ['palette', 'ribbon'] as const;
const alwaysEnabled = (_state: SurfaceCommandState): boolean => true;

function showHierarchy(mode: HierarchyMode): void {
  const state = useViewerStore.getState();
  state.setHierarchyMode(mode);
  state.setPanelShownInSidebar('hierarchy', true);
  liftStartFold('left'); // folded for the start screen, Hierarchy must still appear
  state.setLeftPanelCollapsed(false);
}

export const RIBBON_ELEMENTS_SURFACE_COMMANDS = [
  {
    id: 'search:inline', labelKey: 'commandPalette.search.inline.label',
    keywordsKey: 'commandPalette.search.inline.aliases',
    keywords: 'quick inline search recent queries history clear filters cycle n next previous',
    category: 'Tools', icon: Search, surfaces: ['palette'], enabled: alwaysEnabled,
    run: () => { focusInlineSearch(); },
  },
  {
    id: 'elements:search', labelKey: 'ribbon.elements.search',
    ribbonTooltipKey: 'ribbon.elements.searchTooltip',
    keywords: 'search entities properties filter saved filters query results export', category: 'Tools', icon: Search,
    surfaces: paletteAndRibbon, enabled: alwaysEnabled,
    run: () => {
      const state = useViewerStore.getState();
      state.setSearchModalTab('search');
      state.setSearchModalOpen(true);
    },
  },
  {
    id: 'elements:spatial', labelKey: 'ribbon.elements.spatial',
    ribbonTooltipKey: 'ribbon.elements.spatialTooltip',
    keywords: 'spatial hierarchy', category: 'Tools', icon: Layers3,
    surfaces: paletteAndRibbon, enabled: alwaysEnabled, run: () => showHierarchy('spatial'),
  },
  {
    id: 'elements:class', labelKey: 'ribbon.elements.class',
    ribbonTooltipKey: 'ribbon.elements.classTooltip',
    keywords: 'class hierarchy', category: 'Tools', icon: Layers3,
    surfaces: paletteAndRibbon, enabled: alwaysEnabled, run: () => showHierarchy('type'),
  },
  {
    id: 'elements:type', labelKey: 'ribbon.elements.type',
    ribbonTooltipKey: 'ribbon.elements.typeTooltip',
    keywords: 'ifc type hierarchy', category: 'Tools', icon: Layers3,
    surfaces: paletteAndRibbon, enabled: alwaysEnabled, run: () => showHierarchy('ifc-type'),
  },
  {
    id: 'elements:materials', labelKey: 'ribbon.elements.materials',
    ribbonTooltipKey: 'ribbon.elements.materialsTooltip',
    keywords: 'material hierarchy', category: 'Tools', icon: Layers3,
    surfaces: paletteAndRibbon, enabled: alwaysEnabled, run: () => showHierarchy('material'),
  },
  {
    id: 'elements:groups', labelKey: 'ribbon.elements.groups',
    ribbonTooltipKey: 'ribbon.elements.groupsTooltip',
    keywords: 'group hierarchy', category: 'Tools', icon: Layers3,
    surfaces: paletteAndRibbon, enabled: alwaysEnabled, run: () => showHierarchy('groups'),
  },
  {
    id: 'elements:presentation-layers', labelKey: 'ribbon.elements.presentationLayers',
    ribbonTooltipKey: 'ribbon.elements.presentationLayersTooltip',
    keywords: 'presentation layer assignment hierarchy', category: 'Tools', icon: Layers3,
    surfaces: paletteAndRibbon, enabled: alwaysEnabled, run: () => showHierarchy('presentation-layers'),
  },
  {
    id: 'elements:class-filter', keywordsKey: 'commandPalette.aliases.classes', labelKey: 'ribbon.elements.filter',
    keywords: 'class visibility filter spaces openings annotations grids merge layers fast exact geometry', category: 'Visibility', icon: Filter,
    surfaces: ['ribbon', 'palette'], enabled: alwaysEnabled,
    run: (context) => {
      // The real ribbon trigger owns Radix focus; the palette owns its dialog.
      if (context.contextAction) context.contextAction();
      else context.openClassFilter?.();
    },
  },
  {
    id: 'elements:entity-actions', labelKey: 'commandPalette.elements.entityActions',
    ribbonLabelKey: 'entityContextMenu.entityActions', keywordsKey: 'commandPalette.aliases.entityActions',
    keywords: 'selected entity type storey duplicate delete actions',
    category: 'Tools', icon: Ellipsis,
    surfaces: paletteAndRibbon, enabled: alwaysEnabled,
    run: (context) => {
      if (context.contextAction) context.contextAction();
      else openSelectedEntityActions(undefined, context.entityActionsLauncher?.());
    },
  },
] as const satisfies readonly SurfaceCommandDefinition[];

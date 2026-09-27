/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Mounted Elements controls with no palette or mobile equivalent. */
import { Ellipsis, Filter, Layers3, Search } from 'lucide-react';
import { useViewerStore, type HierarchyMode } from '@/store';
import { runContextAction } from './surface-commands-context';
import type { SurfaceCommandDefinition, SurfaceCommandState } from './surface-commands';

const ribbonOnly = ['ribbon'] as const;
const alwaysEnabled = (_state: SurfaceCommandState): boolean => true;

function showHierarchy(mode: HierarchyMode): void {
  const state = useViewerStore.getState();
  state.setHierarchyMode(mode);
  state.setPanelShownInSidebar('hierarchy', true);
  state.setLeftPanelCollapsed(false);
}

export const RIBBON_ELEMENTS_SURFACE_COMMANDS = [
  {
    id: 'elements:search', labelKey: 'ribbon.elements.search',
    ribbonTooltipKey: 'ribbon.elements.searchTooltip',
    keywords: 'search entities properties', category: 'Tools', icon: Search,
    surfaces: ribbonOnly, enabled: alwaysEnabled,
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
    surfaces: ribbonOnly, enabled: alwaysEnabled, run: () => showHierarchy('spatial'),
  },
  {
    id: 'elements:class', labelKey: 'ribbon.elements.class',
    ribbonTooltipKey: 'ribbon.elements.classTooltip',
    keywords: 'class hierarchy', category: 'Tools', icon: Layers3,
    surfaces: ribbonOnly, enabled: alwaysEnabled, run: () => showHierarchy('type'),
  },
  {
    id: 'elements:type', labelKey: 'ribbon.elements.type',
    ribbonTooltipKey: 'ribbon.elements.typeTooltip',
    keywords: 'ifc type hierarchy', category: 'Tools', icon: Layers3,
    surfaces: ribbonOnly, enabled: alwaysEnabled, run: () => showHierarchy('ifc-type'),
  },
  {
    id: 'elements:materials', labelKey: 'ribbon.elements.materials',
    ribbonTooltipKey: 'ribbon.elements.materialsTooltip',
    keywords: 'material hierarchy', category: 'Tools', icon: Layers3,
    surfaces: ribbonOnly, enabled: alwaysEnabled, run: () => showHierarchy('material'),
  },
  {
    id: 'elements:groups', labelKey: 'ribbon.elements.groups',
    ribbonTooltipKey: 'ribbon.elements.groupsTooltip',
    keywords: 'group hierarchy', category: 'Tools', icon: Layers3,
    surfaces: ribbonOnly, enabled: alwaysEnabled, run: () => showHierarchy('groups'),
  },
  {
    id: 'elements:class-filter', labelKey: 'ribbon.elements.filter',
    keywords: 'class visibility filter', category: 'Visibility', icon: Filter,
    surfaces: ribbonOnly, enabled: alwaysEnabled,
    run: runContextAction,
  },
  {
    id: 'elements:entity-actions', labelKey: 'entityContextMenu.entityActions',
    keywords: 'selected entity type storey duplicate delete actions',
    category: 'Tools', icon: Ellipsis,
    surfaces: ribbonOnly, enabled: alwaysEnabled, run: runContextAction,
  },
] as const satisfies readonly SurfaceCommandDefinition[];

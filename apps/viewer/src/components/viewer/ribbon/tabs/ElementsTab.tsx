/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ribbon · Elements tab — selection actions and class visibility.
 */

import { useCallback } from 'react';
import { ClassVisibility, CopyGuid, ElementTooltips, FocusSelected, HideSelected, IsolateSelected, Search, DisplayAll, Spatial, Class, Type, Material, Group } from '@/icons';
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { resolveGlobalId, useViewerStore, type HierarchyMode } from '@/store';
import { executeBasketIsolate } from '@/store/basket/basketCommands';
import { resetVisibilityForHomeFromStore } from '@/store/homeView';
import { ClassVisibilityMenuContent, useVisibleClassCount } from '../../toolbar/ClassVisibilityMenu';
import {
  RibbonGroup,
  RibbonGroupDivider,
  RibbonLargeButton,
  RibbonSmallButton,
  RibbonSmallStack,
} from '../primitives';

export function ElementsTab() {
  const selectedEntityId = useViewerStore((state) => state.selectedEntityId);
  const selectedEntityIds = useViewerStore((state) => state.selectedEntityIds);
  const hideEntities = useViewerStore((state) => state.hideEntities);
  const clearSelection = useViewerStore((state) => state.clearSelection);
  const cameraCallbacks = useViewerStore((state) => state.cameraCallbacks);
  const hoverTooltipsEnabled = useViewerStore((state) => state.hoverTooltipsEnabled);
  const toggleHoverTooltips = useViewerStore((state) => state.toggleHoverTooltips);
  const mergeLayers = useViewerStore((state) => state.mergeLayers);
  const setSearchModalOpen = useViewerStore((state) => state.setSearchModalOpen);
  const setSearchModalTab = useViewerStore((state) => state.setSearchModalTab);
  const hierarchyMode = useViewerStore((state) => state.hierarchyMode);
  const setHierarchyMode = useViewerStore((state) => state.setHierarchyMode);
  const setLeftPanelCollapsed = useViewerStore((state) => state.setLeftPanelCollapsed);
  const setPanelShownInSidebar = useViewerStore((state) => state.setPanelShownInSidebar);
  const { visible: visibleClassCount } = useVisibleClassCount();

  // Selection size uses the multi-select set when present; falls back to
  // the single legacy `selectedEntityId` so the count still reads "1"
  // for the click-to-pick flow that hasn't migrated.
  const selectionCount = selectedEntityIds.size > 0
    ? selectedEntityIds.size
    : (selectedEntityId !== null ? 1 : 0);
  const hasSelection = selectionCount > 0;

  const handleHide = useCallback(() => {
    // Hide ALL selected entities (multi-select or single)
    const state = useViewerStore.getState();
    const ids: number[] = state.selectedEntityIds.size > 0
      ? Array.from(state.selectedEntityIds)
      : selectedEntityId !== null ? [selectedEntityId] : [];
    if (ids.length > 0) {
      hideEntities(ids);
      clearSelection();
    }
  }, [selectedEntityId, hideEntities, clearSelection]);

  const handleCopyGuid = useCallback(() => {
    if (selectedEntityId === null) return;

    const globalId = resolveGlobalId(selectedEntityId);
    if (globalId) void navigator.clipboard.writeText(globalId);
  }, [selectedEntityId]);

  const handleHierarchyMode = useCallback((mode: HierarchyMode) => {
    setHierarchyMode(mode);
    setPanelShownInSidebar('hierarchy', true);
    setLeftPanelCollapsed(false);
  }, [setHierarchyMode, setLeftPanelCollapsed, setPanelShownInSidebar]);

  return (
    <>
      {/* Selection actions stay put (no appearing/disappearing chrome —
          the ribbon's fixed geography is the point) and read their
          availability from the disabled state. The group label carries
          the live count so scene state is visible at a glance. */}
      <RibbonGroup label="Elements">
        <RibbonLargeButton
          icon={Search}
          label="Search"
          tooltip="Search and filter elements"
          onClick={() => {
            setSearchModalTab('search');
            setSearchModalOpen(true);
          }}
        />
        <RibbonLargeButton
          icon={DisplayAll}
          label="Display all"
          tooltip="Display all (reset filters)"
          shortcut="A"
          onClick={resetVisibilityForHomeFromStore}
        />
        <RibbonLargeButton
          icon={ElementTooltips}
          label="Hover tips"
          tooltip="Show entity tooltips on hover"
          active={hoverTooltipsEnabled}
          onClick={() => toggleHoverTooltips()}
        />
      </RibbonGroup>

      <RibbonGroupDivider />

      <RibbonGroup label={hasSelection ? `Selection · ${selectionCount}` : 'Selection'}>
        <RibbonLargeButton
          icon={IsolateSelected}
          label="Isolate"
          tooltip="Isolate selection (set basket)"
          shortcut="I / ="
          disabled={!hasSelection}
          onClick={() => executeBasketIsolate()}
        />
        <RibbonLargeButton
          icon={HideSelected}
          label="Hide"
          tooltip="Hide selection"
          shortcut="Del / Space"
          disabled={!hasSelection}
          onClick={handleHide}
        />
        <RibbonSmallStack>
          <RibbonSmallButton
            icon={FocusSelected}
            label="Focus"
            tooltip="Focus selection"
            shortcut="F"
            disabled={!hasSelection}
            onClick={() => cameraCallbacks.frameSelection?.()}
          />
          <RibbonSmallButton
            icon={CopyGuid}
            label="Copy guid"
            tooltip="Copy GlobalID"
            disabled={selectedEntityId === null}
            onClick={handleCopyGuid}
          />
        </RibbonSmallStack>
      </RibbonGroup>

      <RibbonGroupDivider />

      <RibbonGroup label="Hierarchy">
        <RibbonLargeButton
          icon={Spatial}
          label="Spatial"
          tooltip="Displays ifc spatial structure"
          active={hierarchyMode === 'spatial'}
          onClick={() => handleHierarchyMode('spatial')}
        />
        <RibbonLargeButton
          icon={Class}
          label="Class"
          tooltip="Displays class of elements"
          active={hierarchyMode === 'type'}
          onClick={() => handleHierarchyMode('type')}
        />
        <RibbonLargeButton
          icon={Type}
          label="Type"
          tooltip="Displays type of elements"
          active={hierarchyMode === 'ifc-type'}
          onClick={() => handleHierarchyMode('ifc-type')}
        />
        <RibbonLargeButton
          icon={Material}
          label="Materials"
          tooltip="Displays materials of the model"
          active={hierarchyMode === 'material'}
          onClick={() => handleHierarchyMode('material')}
        />
        <RibbonLargeButton
          icon={Group}
          label="Groups"
          tooltip="Displays groups of the model"
          active={hierarchyMode === 'groups'}
          onClick={() => handleHierarchyMode('groups')}
        />
      </RibbonGroup>
      <RibbonGroupDivider />

      <RibbonGroup label="Visibility">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <RibbonLargeButton
              icon={ClassVisibility}
              label="Filter"
              hasMenu
              tooltip={mergeLayers
                ? `Class visibility (${visibleClassCount} on) · Merge Multilayer Walls is on`
                : `Class visibility (${visibleClassCount} on)`}
              badge={mergeLayers ? (
                // Tiny accent dot announcing that a non-default load
                // setting is active. Decorative — semantics live on the
                // button's tooltip.
                <span aria-hidden="true" className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-primary ring-1 ring-background" />
              ) : undefined}
            />
          </DropdownMenuTrigger>
          <ClassVisibilityMenuContent align="start" />
        </DropdownMenu>
      </RibbonGroup>
    </>
  );
}

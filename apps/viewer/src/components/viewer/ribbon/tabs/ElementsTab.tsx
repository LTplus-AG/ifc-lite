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
import { hideSelectionFromStore } from '@/store/hideSelection';
import { useTranslation } from '@/i18n';
import { ClassVisibilityMenuContent, useVisibleClassCount } from '../../toolbar/ClassVisibilityMenu';
import {
  RibbonGroup,
  RibbonGroupDivider,
  RibbonLargeButton,
  RibbonSmallButton,
  RibbonSmallStack,
} from '../primitives';

export function ElementsTab() {
  const { t } = useTranslation();
  const selectedEntityId = useViewerStore((state) => state.selectedEntityId);
  const selectedEntityIds = useViewerStore((state) => state.selectedEntityIds);
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
      <RibbonGroup label={t('ribbon.elements.elementsGroup')}>
        <RibbonLargeButton
          icon={Search}
          label={t('ribbon.elements.search')}
          tooltip={t('ribbon.elements.searchTooltip')}
          onClick={() => {
            setSearchModalTab('search');
            setSearchModalOpen(true);
          }}
        />
        <RibbonLargeButton
          icon={DisplayAll}
          label={t('ribbon.elements.showAll')}
          tooltip={t('ribbon.elements.showAllTooltip')}
          shortcut="A"
          onClick={() => resetVisibilityForHomeFromStore('show_all')}
        />
        <RibbonLargeButton
          icon={ElementTooltips}
          label={t('ribbon.elements.hoverTips')}
          tooltip={t('ribbon.elements.hoverTipsTooltip')}
          active={hoverTooltipsEnabled}
          onClick={() => toggleHoverTooltips()}
        />
      </RibbonGroup>

      <RibbonGroupDivider />

      <RibbonGroup label={hasSelection ? t('ribbon.elements.selectionGroupCount', { count: selectionCount }) : t('ribbon.elements.selectionGroup')}>
        <RibbonLargeButton
          icon={IsolateSelected}
          label={t('ribbon.elements.isolate')}
          tooltip={t('ribbon.elements.isolateTooltip')}
          shortcut="I"
          disabled={!hasSelection}
          onClick={() => executeBasketIsolate()}
        />
        <RibbonLargeButton
          icon={HideSelected}
          label={t('ribbon.elements.hide')}
          tooltip={t('ribbon.elements.hideTooltip')}
          shortcut={t('ribbon.elements.hideShortcut')}
          disabled={!hasSelection}
          onClick={hideSelectionFromStore}
        />
        <RibbonSmallStack>
          <RibbonSmallButton
            icon={FocusSelected}
            label={t('ribbon.elements.frame')}
            tooltip={t('ribbon.elements.frameTooltip')}
            shortcut="F"
            disabled={!hasSelection}
            onClick={() => cameraCallbacks.frameSelection?.()}
          />
          <RibbonSmallButton
            icon={CopyGuid}
            label={t('ribbon.elements.copyGuid')}
            tooltip={t('ribbon.elements.copyGuidTooltip')}
            disabled={selectedEntityId === null}
            onClick={handleCopyGuid}
          />
        </RibbonSmallStack>
      </RibbonGroup>

      <RibbonGroupDivider />

      <RibbonGroup label={t('ribbon.elements.hierarchyGroup')}>
        <RibbonLargeButton
          icon={Spatial}
          label={t('ribbon.elements.spatial')}
          tooltip={t('ribbon.elements.spatialTooltip')}
          active={hierarchyMode === 'spatial'}
          onClick={() => handleHierarchyMode('spatial')}
        />
        <RibbonLargeButton
          icon={Class}
          label={t('ribbon.elements.class')}
          tooltip={t('ribbon.elements.classTooltip')}
          active={hierarchyMode === 'type'}
          onClick={() => handleHierarchyMode('type')}
        />
        <RibbonLargeButton
          icon={Type}
          label={t('ribbon.elements.type')}
          tooltip={t('ribbon.elements.typeTooltip')}
          active={hierarchyMode === 'ifc-type'}
          onClick={() => handleHierarchyMode('ifc-type')}
        />
        <RibbonLargeButton
          icon={Material}
          label={t('ribbon.elements.materials')}
          tooltip={t('ribbon.elements.materialsTooltip')}
          active={hierarchyMode === 'material'}
          onClick={() => handleHierarchyMode('material')}
        />
        <RibbonLargeButton
          icon={Group}
          label={t('ribbon.elements.groups')}
          tooltip={t('ribbon.elements.groupsTooltip')}
          active={hierarchyMode === 'groups'}
          onClick={() => handleHierarchyMode('groups')}
        />
      </RibbonGroup>
      <RibbonGroupDivider />

      <RibbonGroup label={t('ribbon.elements.visibilityGroup')}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <RibbonLargeButton
              icon={ClassVisibility}
              label={t('ribbon.elements.filter')}
              hasMenu
              tooltip={mergeLayers
                ? t('ribbon.elements.filterMergedTooltip', { count: visibleClassCount })
                : t('ribbon.elements.filterTooltip', { count: visibleClassCount })}
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

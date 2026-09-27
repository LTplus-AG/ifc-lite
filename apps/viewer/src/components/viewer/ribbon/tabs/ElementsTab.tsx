/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ribbon · Elements tab — selection actions and class visibility.
 */

import { useCallback, useContext } from 'react';
import { ClassVisibility, CopyGuid, ElementTooltips, EntityActions, FocusSelected, HideSelected, IsolateSelected, Search, DisplayAll, Spatial, Class, Type, Material, Group } from '@/icons';
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { resolveGlobalId, useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { BimReactContext } from '@/sdk/BimProvider';
import { surfaceCommand } from '../../surface-commands';
import { runSurfaceCommand } from '../../surface-command-run';
import { ClassVisibilityMenuContent, useVisibleClassCount } from '../../toolbar/ClassVisibilityMenu';
import {
  RibbonGroup,
  RibbonGroupDivider,
  RibbonSmallStack,
} from '../primitives';
import { RibbonCommandLargeButton, RibbonCommandSmallButton } from '../command-button';

export function ElementsTab() {
  const { t } = useTranslation();
  const bim = useContext(BimReactContext);
  const toggleCollection = surfaceCommand('vis:toggle-iso', 'ribbon');
  const resetColors = surfaceCommand('vis:reset-colors', 'ribbon');
  const collabRole = useViewerStore((s) => s.collabRole);
  const canEditInSession = collabRole === null || collabRole === 'editor' || collabRole === 'admin';
  const selectedEntityId = useViewerStore((state) => state.selectedEntityId);
  const selectedEntityIds = useViewerStore((state) => state.selectedEntityIds);
  const openContextMenu = useViewerStore((state) => state.openContextMenu);
  const hoverTooltipsEnabled = useViewerStore((state) => state.hoverTooltipsEnabled);
  const mergeLayers = useViewerStore((state) => state.mergeLayers);
  const hierarchyMode = useViewerStore((state) => state.hierarchyMode);
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

  return (
    <>
      {/* Selection actions stay put (no appearing/disappearing chrome —
          the ribbon's fixed geography is the point) and read their
          availability from the disabled state. The group label carries
          the live count so scene state is visible at a glance. */}
      <RibbonGroup label={t('ribbon.elements.elementsGroup')}>
        <RibbonCommandLargeButton
          commandId="elements:search"
          icon={Search}
          onClick={() => runSurfaceCommand(surfaceCommand('elements:search', 'ribbon'), { surface: 'ribbon' })}
        />
        <RibbonCommandLargeButton
          commandId="vis:show"
          icon={DisplayAll}
          onClick={() => runSurfaceCommand(surfaceCommand('vis:show', 'ribbon'), { surface: 'ribbon' })}
        />
        <RibbonCommandLargeButton
          commandId="pref:tooltips"
          icon={ElementTooltips}
          active={hoverTooltipsEnabled}
          onClick={() => runSurfaceCommand(surfaceCommand('pref:tooltips', 'ribbon'), { surface: 'ribbon' })}
        />
      </RibbonGroup>

      <RibbonGroupDivider />

      <RibbonGroup label={hasSelection ? t('ribbon.elements.selectionGroupCount', { count: selectionCount }) : t('ribbon.elements.selectionGroup')}>
        <RibbonCommandLargeButton
          commandId="vis:isolate"
          icon={IsolateSelected}
          disabled={!hasSelection}
          onClick={() => runSurfaceCommand(surfaceCommand('vis:isolate', 'ribbon'), { surface: 'ribbon' })}
        />
        <RibbonCommandLargeButton
          commandId="vis:hide"
          icon={HideSelected}
          disabled={!hasSelection}
          onClick={() => runSurfaceCommand(surfaceCommand('vis:hide', 'ribbon'), { surface: 'ribbon' })}
        />
        <RibbonSmallStack>
          <RibbonCommandSmallButton
            commandId="view:frame"
            icon={FocusSelected}
            disabled={!hasSelection}
            onClick={() => runSurfaceCommand(surfaceCommand('view:frame', 'ribbon'), { surface: 'ribbon' })}
          />
          <RibbonCommandSmallButton
            commandId="context:copy-global-id"
            icon={CopyGuid}
            disabled={selectedEntityId === null}
            onClick={() => runSurfaceCommand(surfaceCommand('context:copy-global-id', 'ribbon'), {
              surface: 'ribbon', contextAction: handleCopyGuid,
            })}
          />
          <RibbonCommandSmallButton
            commandId="elements:entity-actions"
            icon={EntityActions}
            disabled={!hasSelection}
            onClick={(event) => {
              const targetId = selectedEntityIds.size > 0
                ? (selectedEntityId !== null && selectedEntityIds.has(selectedEntityId)
                    ? selectedEntityId : selectedEntityIds.values().next().value)
                : selectedEntityId;
              if (targetId === undefined || targetId === null) return;
              const rect = event.currentTarget.getBoundingClientRect();
              runSurfaceCommand(surfaceCommand('elements:entity-actions', 'ribbon'), {
                surface: 'ribbon',
                contextAction: () => openContextMenu(targetId, Math.max(1, rect.left + rect.width / 2), Math.max(1, rect.bottom)),
              });
            }}
          />
        </RibbonSmallStack>
      </RibbonGroup>

      <RibbonGroupDivider />

      <RibbonGroup label={t('ribbon.elements.hierarchyGroup')}>
        <RibbonCommandLargeButton
          commandId="elements:spatial"
          icon={Spatial}
          active={hierarchyMode === 'spatial'}
          onClick={() => runSurfaceCommand(surfaceCommand('elements:spatial', 'ribbon'), { surface: 'ribbon' })}
        />
        <RibbonCommandLargeButton
          commandId="elements:class"
          icon={Class}
          active={hierarchyMode === 'type'}
          onClick={() => runSurfaceCommand(surfaceCommand('elements:class', 'ribbon'), { surface: 'ribbon' })}
        />
        <RibbonCommandLargeButton
          commandId="elements:type"
          icon={Type}
          active={hierarchyMode === 'ifc-type'}
          onClick={() => runSurfaceCommand(surfaceCommand('elements:type', 'ribbon'), { surface: 'ribbon' })}
        />
        <RibbonCommandLargeButton
          commandId="elements:materials"
          icon={Material}
          active={hierarchyMode === 'material'}
          onClick={() => runSurfaceCommand(surfaceCommand('elements:materials', 'ribbon'), { surface: 'ribbon' })}
        />
        <RibbonCommandLargeButton
          commandId="elements:groups"
          icon={Group}
          active={hierarchyMode === 'groups'}
          onClick={() => runSurfaceCommand(surfaceCommand('elements:groups', 'ribbon'), { surface: 'ribbon' })}
        />
      </RibbonGroup>
      <RibbonGroupDivider />

      <RibbonGroup label={t('ribbon.elements.visibilityGroup')}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <RibbonCommandLargeButton
              commandId="elements:class-filter"
              triggerOnly
              icon={ClassVisibility}
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
        <RibbonSmallStack>
          {[toggleCollection, resetColors].map((command) => (
            <RibbonCommandSmallButton
              key={command.id}
              commandId={command.id}
              tooltip={t(command.labelKey)}
              disabled={!command.enabled({ canEditInSession })}
              onClick={() => runSurfaceCommand(command, {
                surface: 'ribbon',
                resetColors: () => {
                  if (!bim) throw new Error('Reset Colors requires a BimProvider');
                  bim.viewer.resetColors();
                },
              })}
            />
          ))}
        </RibbonSmallStack>
      </RibbonGroup>
    </>
  );
}

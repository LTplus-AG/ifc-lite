/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ribbon · File tab — everything that moves model bytes in or out:
 * open / add / refresh, the exporter fleet, and link-based sharing.
 */

import React from 'react';
import { AddFile, CloudSources, Loading, OpenFile, SaveFederationSetup, Refresh, Share, CollabsRoom } from '@/icons';
import { useViewerStore } from '@/store';
import { useIfc } from '@/hooks/useIfc';
import { isCollabEnabled } from '@/lib/collab/config';
import { useTranslation } from '@/i18n';
import type { FileCommands } from '../../toolbar/useFileCommands';
import { useWorkspacePanelControls } from '../../toolbar/useWorkspacePanelControls';
import { surfaceCommand } from '../../surface-commands';
import { RibbonExportGroup } from './RibbonExportGroup';
import { RIBBON_EXPORT_ICONS } from './ribbon-export-icons';
import {
  RibbonGroup,
  RibbonGroupDivider,
  RibbonSmallStack,
} from '../primitives';
import { RibbonCommandLargeButton, RibbonCommandSmallButton } from '../command-button';

export function FileTab({ fileCommands }: { fileCommands: FileCommands }) {
  const { t } = useTranslation();
  const { handleOpenClick, handleAddModelClick, handleRefresh, canRefresh, hasModelsLoaded, openShareDialog } = fileCommands;
  const { loading, models } = useIfc();
  const saveSetup = surfaceCommand('file:save-federation-setup', 'ribbon');
  const shareCommand = surfaceCommand('file:share', 'ribbon');
  const openSetup = surfaceCommand('file:open-federation-setup', 'ribbon');
  const modelTags = surfaceCommand('file:model-tags', 'ribbon');
  const collabRole = useViewerStore((s) => s.collabRole);
  const canEditInSession = collabRole === null || collabRole === 'editor' || collabRole === 'admin';

  // Collaboration: the Share cluster is gated behind the collab feature flag.
  // The ShareDialog itself (and its `ifc-lite:open-share-dialog` listener)
  // lives in useFileCommands so it stays mounted on every tab and while the
  // ribbon is collapsed — this panel only holds the buttons.
  const collabEnabled = React.useMemo(() => isCollabEnabled(), []);
  const collabPeerCount = useViewerStore((s) => s.collabPeers.length);
  const collabRoomId = useViewerStore((s) => s.collabRoomId);
  const collabPanelVisible = useViewerStore((s) => s.collabPanelVisible);

  // Cloud sources (CDE integrations) is a model SOURCE, so it belongs on the
  // tab that moves bytes — not with the analysis panels. Until now the
  // ActivityBar rail was its only entry point, the same gap Location zones
  // had before #2508, and the parity guard cannot see it: both toolbars
  // already reach `toggleWorkspacePanel` for other panels.
  const { activeWorkspacePanels, handleToggleRightPanel } = useWorkspacePanelControls('ribbon');

  return (
    <>
      <RibbonGroup label={t('ribbon.file.modelGroup')}>
        <RibbonCommandLargeButton
          commandId="file:open"
          icon={loading ? Loading : OpenFile}
          disabled={loading}
          className={loading ? '[&_svg]:animate-spin' : undefined}
          commandContext={{ openFiles: () => { void handleOpenClick(); } }}
        />
        <RibbonCommandLargeButton
          commandId="panel:sources"
          icon={CloudSources}
          tooltip={t('ribbon.file.cloudSourcesTooltip')}
          active={activeWorkspacePanels.has('sources')}
          commandContext={{ activateRightPanel: () => handleToggleRightPanel('sources') }}
        />
        <RibbonSmallStack>
          <RibbonCommandSmallButton
            commandId="file:add-model"
            icon={AddFile}
            disabled={loading || !hasModelsLoaded}
            commandContext={{ addModel: () => { void handleAddModelClick(); } }}
          />
          <RibbonCommandSmallButton
            commandId="file:refresh"
            icon={Refresh}
            tooltip={models.size > 1 ? t('ribbon.file.refreshModelsTooltip') : t('ribbon.file.refreshModelTooltip')}
            disabled={loading || !canRefresh}
            commandContext={{ refreshModels: handleRefresh }}
          />
        </RibbonSmallStack>
        {[[saveSetup, openSetup], [modelTags]].map((commands) => (
          <RibbonSmallStack key={commands[0].id} className="gap-1">
            {commands.map((command) => (
              <RibbonCommandSmallButton
                key={command.id}
                commandId={command.id}
                icon={command.id === saveSetup.id ? SaveFederationSetup : undefined}
                tooltip={t(command.labelKey)}
                className="min-h-6"
                disabled={!command.enabled({ canEditInSession })}
              />
            ))}
          </RibbonSmallStack>
        ))}
      </RibbonGroup>

      <RibbonGroupDivider />

      <RibbonExportGroup icons={RIBBON_EXPORT_ICONS} />

      {collabEnabled && (
        <>
          <RibbonGroupDivider />
          <RibbonGroup label={t('ribbon.file.shareGroup')}>
            <RibbonCommandLargeButton
              commandId={shareCommand.id}
              icon={Share}
              disabled={!hasModelsLoaded}
              commandContext={{ openShareDialog }}
              badge={collabPeerCount > 0 ? (
                <span className="absolute right-1 top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-1 text-2xs font-medium text-primary-foreground">
                  {collabPeerCount + 1}
                </span>
              ) : undefined}
            />
            {/* Room panel toggle — live presence + management. Shown whenever
                collab is on, not only inside a room: the palette and rail offer
                it unconditionally. Gating it here left ribbon users unable to
                open the panel before joining. It also contradicted this toolbar's own rule
                that its geography stays put rather than appearing mid-session. */}
            <RibbonCommandLargeButton
              commandId="panel:collab"
              icon={CollabsRoom}
              tooltip={collabRoomId ? t('ribbon.file.roomTooltip') : t('ribbon.file.roomNotJoinedTooltip')}
              active={collabPanelVisible}
              commandContext={{ activateRightPanel: () => useViewerStore.getState().toggleWorkspacePanel('collab', 'ribbon') }}
              badge={collabPeerCount > 0 ? (
                <span className="absolute right-1 top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-emerald-500 px-1 text-2xs font-medium text-white">
                  {collabPeerCount + 1}
                </span>
              ) : undefined}
            />
          </RibbonGroup>
        </>
      )}
    </>
  );
}

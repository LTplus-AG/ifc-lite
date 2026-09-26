/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ribbon · File tab — everything that moves model bytes in or out:
 * open / add / refresh, the exporter fleet, and link-based sharing.
 */

import React from 'react';
import { AddFile, CloudSources, Loading, OpenFile, Refresh, Share, CollabsRoom } from '@/icons';
import { useViewerStore } from '@/store';
import { useIfc } from '@/hooks/useIfc';
import { isCollabEnabled } from '@/lib/collab/config';
import { useTranslation } from '@/i18n';
import type { FileCommands } from '../../toolbar/useFileCommands';
import { useWorkspacePanelControls } from '../../toolbar/useWorkspacePanelControls';
import { RibbonExportGroup } from './RibbonExportGroup';
import { RIBBON_EXPORT_ICONS } from './ribbon-export-icons';
import {
  RibbonGroup,
  RibbonGroupDivider,
  RibbonLargeButton,
  RibbonSmallButton,
  RibbonSmallStack,
} from '../primitives';

export function FileTab({ fileCommands }: { fileCommands: FileCommands }) {
  const { t } = useTranslation();
  const { handleOpenClick, handleAddModelClick, handleRefresh, canRefresh, hasModelsLoaded, openShareDialog } = fileCommands;
  const { loading, models } = useIfc();

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
        <RibbonLargeButton
          icon={loading ? Loading : OpenFile}
          label={t('ribbon.file.open')}
          tooltip={t('ribbon.file.openTooltip')}
          disabled={loading}
          className={loading ? '[&_svg]:animate-spin' : undefined}
          onClick={() => { void handleOpenClick(); }}
        />
        <RibbonLargeButton
          icon={CloudSources}
          label={t('ribbon.file.cloudSources')}
          tooltip={t('ribbon.file.cloudSourcesTooltip')}
          active={activeWorkspacePanels.has('sources')}
          onClick={() => handleToggleRightPanel('sources')}
        />
        <RibbonSmallStack>
          <RibbonSmallButton
            icon={AddFile}
            label={t('ribbon.file.addModel')}
            tooltip={t('ribbon.file.addModelTooltip')}
            disabled={loading || !hasModelsLoaded}
            onClick={() => { void handleAddModelClick(); }}
          />
          <RibbonSmallButton
            icon={Refresh}
            label={t('ribbon.file.refresh')}
            tooltip={models.size > 1 ? t('ribbon.file.refreshModelsTooltip') : t('ribbon.file.refreshModelTooltip')}
            disabled={loading || !canRefresh}
            onClick={() => { void handleRefresh(); }}
          />
        </RibbonSmallStack>
      </RibbonGroup>

      <RibbonGroupDivider />

      <RibbonExportGroup icons={RIBBON_EXPORT_ICONS} />

      {collabEnabled && (
        <>
          <RibbonGroupDivider />
          <RibbonGroup label={t('ribbon.file.shareGroup')}>
            <RibbonLargeButton
              icon={Share}
              label={t('ribbon.file.share')}
              tooltip={t('ribbon.file.shareTooltip')}
              disabled={!hasModelsLoaded}
              onClick={openShareDialog}
              badge={collabPeerCount > 0 ? (
                <span className="absolute right-1 top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-medium text-primary-foreground">
                  {collabPeerCount + 1}
                </span>
              ) : undefined}
            />
            {/* Room panel toggle — live presence + management. Shown whenever
                collab is on, not only inside a room: the classic strip's Panels
                menu, the palette and the rail all offer it unconditionally, and
                gating it here left ribbon users unable to open the panel at all
                before joining. It also contradicted this toolbar's own rule
                that its geography stays put rather than appearing mid-session. */}
            <RibbonLargeButton
              icon={CollabsRoom}
              label={t('ribbon.file.room')}
              tooltip={collabRoomId ? t('ribbon.file.roomTooltip') : t('ribbon.file.roomNotJoinedTooltip')}
              active={collabPanelVisible}
              onClick={() => useViewerStore.getState().toggleWorkspacePanel('collab', 'ribbon')}
              badge={collabPeerCount > 0 ? (
                <span className="absolute right-1 top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-emerald-500 px-1 text-[9px] font-medium text-white">
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

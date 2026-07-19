/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ribbon · File tab — everything that moves model bytes in or out:
 * open / add / refresh, the exporter fleet, and link-based sharing.
 */

import React from 'react';
import { Share2, Users } from 'lucide-react';
import { AddFile, Loading, OpenFile, Refresh, Screenshot, FileCsv, FileIfc, FileGlb, FileKmz, FileJson, FileHbjson } from '@/icons';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useViewerStore } from '@/store';
import { useIfc } from '@/hooks/useIfc';
import { isCollabEnabled } from '@/lib/collab/config';
import { ExportDialog } from '../../ExportDialog';
import { GLBExportDialog } from '../../GLBExportDialog';
import { KmzExportDialog } from '../../KmzExportDialog';
import { HbjsonExportDialog } from '../../HbjsonExportDialog';
import type { FileCommands } from '../../toolbar/useFileCommands';
import { useExportCommands } from '../../toolbar/useExportCommands';
import {
  RibbonGroup,
  RibbonGroupDivider,
  RibbonLargeButton,
  RibbonSmallButton,
  RibbonSmallStack,
} from '../primitives';

export function FileTab({ fileCommands }: { fileCommands: FileCommands }) {
  const { handleOpenClick, handleAddModelClick, handleRefresh, canRefresh, hasModelsLoaded, openShareDialog } = fileCommands;
  const { loading, models, ifcDataStore } = useIfc();
  const { handleExportCSV, handleExportJSON, handleScreenshot } = useExportCommands();

  // Collaboration: the Share cluster is gated behind the collab feature flag.
  // The ShareDialog itself (and its `ifc-lite:open-share-dialog` listener)
  // lives in useFileCommands so it stays mounted on every tab and while the
  // ribbon is collapsed — this panel only holds the buttons.
  const collabEnabled = React.useMemo(() => isCollabEnabled(), []);
  const collabPeerCount = useViewerStore((s) => s.collabPeers.length);
  const collabRoomId = useViewerStore((s) => s.collabRoomId);
  const collabPanelVisible = useViewerStore((s) => s.collabPanelVisible);

  const canExport = hasModelsLoaded || Boolean(ifcDataStore);

  return (
    <>
      <RibbonGroup label="Model">
        <RibbonLargeButton
          icon={loading ? Loading : OpenFile}
          label="Open"
          tooltip="Open model from disk"
          disabled={loading}
          className={loading ? '[&_svg]:animate-spin' : undefined}
          onClick={() => { void handleOpenClick(); }}
        />
        <RibbonSmallStack>
          <RibbonSmallButton
            icon={AddFile}
            label="Add model"
            tooltip="Add model to scene (multi-select supported)"
            disabled={loading || !hasModelsLoaded}
            onClick={() => { void handleAddModelClick(); }}
          />
          <RibbonSmallButton
            icon={Refresh}
            label="Refresh"
            tooltip={models.size > 1 ? 'Refresh models from disk' : 'Refresh model from disk'}
            disabled={loading || !canRefresh}
            onClick={() => { void handleRefresh(); }}
          />
        </RibbonSmallStack>
      </RibbonGroup>

      <RibbonGroupDivider />

      <RibbonGroup label="Export">
        {/* Gate on any loaded model, not the legacy single-model geometryResult:
            federated / multi-model sessions populate `models` but leave
            geometryResult null, which would hide the whole export group. */}
        <ExportDialog
          trigger={
            <RibbonLargeButton icon={FileIfc} label="IFC" tooltip="Export IFC (with changes)" disabled={!canExport} />
          }
        />
        <RibbonSmallStack>
          <GLBExportDialog
            trigger={<RibbonSmallButton icon={FileGlb} label="GLB" tooltip="Export GLB (3D model)" disabled={!canExport} />}
          />
          <KmzExportDialog
            trigger={<RibbonSmallButton icon={FileKmz} label="KMZ" tooltip="Export KMZ (Google Earth Pro)" disabled={!canExport} />}
          />
          <HbjsonExportDialog
            trigger={<RibbonSmallButton icon={FileHbjson} label="HBJSON" tooltip="Export HBJSON (energy model)" disabled={!canExport} />}
          />
        </RibbonSmallStack>
        <RibbonSmallStack>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <RibbonSmallButton icon={FileCsv} label="CSV" hasMenu tooltip="Export CSV tables" disabled={!ifcDataStore} />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onClick={() => handleExportCSV('entities')}>
                <FileCsv className="h-4 w-4 mr-2" />
                Entities
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleExportCSV('properties')}>
                <FileCsv className="h-4 w-4 mr-2" />
                Properties
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleExportCSV('quantities')}>
                <FileCsv className="h-4 w-4 mr-2" />
                Quantities
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => handleExportCSV('spatial')}>
                <FileCsv className="h-4 w-4 mr-2" />
                Spatial Hierarchy
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <RibbonSmallButton
            icon={FileJson}
            label="JSON"
            tooltip="Export JSON (all data)"
            disabled={!ifcDataStore}
            onClick={handleExportJSON}
          />
          <RibbonSmallButton icon={Screenshot} label="Screenshot" tooltip="Save viewport as PNG" onClick={handleScreenshot} />
        </RibbonSmallStack>
      </RibbonGroup>

      {collabEnabled && (
        <>
          <RibbonGroupDivider />
          <RibbonGroup label="Share">
            <RibbonLargeButton
              icon={Share2}
              label="Share"
              tooltip="Share: link-based multiuser collaboration"
              disabled={!hasModelsLoaded}
              onClick={openShareDialog}
              badge={collabPeerCount > 0 ? (
                <span className="absolute right-1 top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-medium text-primary-foreground">
                  {collabPeerCount + 1}
                </span>
              ) : undefined}
            />
            {/* Room panel toggle — live presence + management, only while in a room. */}
            {collabRoomId && (
              <RibbonLargeButton
                icon={Users}
                label="Room"
                tooltip="Collaboration room"
                active={collabPanelVisible}
                onClick={() => useViewerStore.getState().toggleWorkspacePanel('collab')}
                badge={collabPeerCount > 0 ? (
                  <span className="absolute right-1 top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-emerald-500 px-1 text-[9px] font-medium text-white">
                    {collabPeerCount + 1}
                  </span>
                ) : undefined}
              />
            )}
          </RibbonGroup>
        </>
      )}
    </>
  );
}

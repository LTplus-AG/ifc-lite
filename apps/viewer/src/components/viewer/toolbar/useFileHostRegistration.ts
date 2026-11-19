/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Persistent toolbar host registration, shared by desktop/mobile (#8947). */
import { useEffect, useRef } from 'react';
import { useViewerStore } from '@/store';
import { selectCanRefreshModels } from '@/hooks/model-presence';
import { startBlankModel } from '@/hooks/startBlankModel';
import type { useIfcLoader } from '@/hooks/useIfcLoader';
import { toast } from '@/components/ui/toast';
import { getMountedFileHost, registerMountedFileHost, type MountedFileHost } from './mounted-file-host';

interface FileHostActions {
  handleOpenClick: () => Promise<void>;
  handleAddModelClick: () => Promise<void>;
  handleRefresh: () => Promise<void>;
  openShareDialog?: () => void;
  loadFile: ReturnType<typeof useIfcLoader>['loadFile'];
}
function reportError(error: unknown) {
  console.error('[useFileCommands] File command failed', error);
  toast.error(error instanceof Error ? error.message : String(error));
}
export function useFileHostRegistration({ handleOpenClick, handleAddModelClick, handleRefresh,
  openShareDialog, loadFile }: FileHostActions): void {
  const ownerRef = useRef<object | null>(null);
  // Only a real effect lifetime change retires an in-flight blank action.
  // Loader metadata and locale updates refresh callbacks on this same owner.
  useEffect(() => {
    ownerRef.current = {};
    return () => { ownerRef.current = null; };
  }, []);
  useEffect(() => {
    const owner = ownerRef.current;
    if (!owner) return;
    const host: MountedFileHost = {
      owner,
      openFiles: () => {
        if (!useViewerStore.getState().loading) void handleOpenClick().catch(reportError);
      },
      addModel: () => {
        if (!useViewerStore.getState().loading) void handleAddModelClick().catch(reportError);
      },
      refreshModels: async () => {
        const state = useViewerStore.getState();
        if (state.loading || !selectCanRefreshModels(state)) return;
        try { await handleRefresh(); } catch (error) { reportError(error); }
      },
      startBlank: () => { void startBlankModel(loadFile, () => ownerRef.current === owner && getMountedFileHost()?.owner === owner).catch(reportError); },
      openShareDialog,
    };
    return registerMountedFileHost(host);
  }, [handleOpenClick, handleAddModelClick, handleRefresh, openShareDialog, loadFile]);
  useEffect(() => {
    const handler = () => { void handleOpenClick().catch(reportError); };
    window.addEventListener('ifc-lite:open-files', handler);
    return () => window.removeEventListener('ifc-lite:open-files', handler);
  }, [handleOpenClick]);
}

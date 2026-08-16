/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef } from 'react';
import type { SourceContainer, SourceFile, SourceProject } from '@ifc-lite/plugin-api';
import { toast } from '@/components/ui/toast';
import { favouriteKey, type SourceFavourite } from '@/lib/sources/favourites';

interface UseSourceFavouriteJumpOptions {
  /** The favourite to open, or null when the browser was entered normally. */
  target: SourceFavourite | null;
  selectedProject: SourceProject | null;
  selectedFileArea: SourceContainer | null;
  selectedContainer: SourceContainer | null;
  sortedFolders: readonly SourceContainer[];
  allFiles: readonly SourceFile[];
  loadingFolders: boolean;
  loadingFiles: boolean;
  /** Browser state the jump rebuilds, in the order the wizard would have reached it. */
  enterFileArea: (project: SourceProject, fileArea: SourceContainer) => void;
  selectContainer: (container: SourceContainer) => void;
  toggleFile: (file: SourceFile) => void;
  /** Refreshes a stored label the source renamed underneath the favourite. */
  renameFavourite: (key: string, name: string) => void;
}

/**
 * Opens a favourite in the browser, in two phases — because `SourceBrowser` is
 * a three-step wizard and each step is an id-only listing call whose data
 * arrives a render later.
 *
 * Phase 1 rebuilds the state the user would have reached by hand (project,
 * file area, folders step) and requests the area's catalog. Phase 2 waits for
 * that listing before descending into the favourited folder, and — for a file
 * favourite — before preselecting the file, which cannot be selected earlier
 * because `SourceBrowser`'s reconcile effect drops a selection that is not in
 * the current listing.
 */
export function useSourceFavouriteJump({
  target,
  selectedProject,
  selectedFileArea,
  selectedContainer,
  sortedFolders,
  allFiles,
  loadingFolders,
  loadingFiles,
  enterFileArea,
  selectContainer,
  toggleFile,
  renameFavourite,
}: UseSourceFavouriteJumpOptions): void {
  const appliedRef = useRef<SourceFavourite | null>(null);
  const pendingRef = useRef<SourceFavourite | null>(null);

  // The cleanup re-arming the jump is load-bearing rather than tidy. Under
  // StrictMode a mount runs effect -> cleanup -> effect, and both
  // `useSourceCatalogSync` and `usePagedList` abort their in-flight request and
  // bump their request generation in their own unmount cleanups. A jump that
  // fired only on the first pass therefore had its listing aborted by the
  // teardown in between and — generation now stale — the `finally` that clears
  // `loadingFolders`/`loadingFiles` no longer applied: two spinners forever,
  // with no request outstanding. Re-arming makes the second pass re-issue it.
  // `enterFileArea` must stay referentially stable for the same reason; an
  // unstable one would tear down and restart the listing on every render.
  useEffect(() => {
    if (!target || appliedRef.current === target) return;
    appliedRef.current = target;
    enterFileArea(
      { id: target.projectId, name: target.projectName },
      { id: target.fileAreaId, name: target.fileAreaName },
    );
    pendingRef.current = target;

    return () => {
      appliedRef.current = null;
      pendingRef.current = null;
    };
  }, [enterFileArea, target]);

  useEffect(() => {
    const pending = pendingRef.current;
    if (!pending || !selectedProject || !selectedFileArea) return;

    // Descend into the favourited folder when it is deeper than the area root.
    if (pending.containerId !== pending.fileAreaId && selectedContainer?.id !== pending.containerId) {
      const match = sortedFolders.find((folder) => folder.id === pending.containerId);
      if (!match && loadingFolders) return;
      // Renamed upstream: the id still opens it and only the label went stale,
      // so refresh the label rather than leave the favourites list lying.
      if (match && match.name !== pending.containerName) {
        renameFavourite(favouriteKey(pending), match.name);
      }
      selectContainer(
        match ?? { id: pending.containerId, name: pending.containerName, parentId: pending.fileAreaId },
      );
      if (pending.kind === 'folder') pendingRef.current = null;
      return;
    }
    if (pending.kind === 'folder') {
      pendingRef.current = null;
      return;
    }

    const file = allFiles.find((candidate) => candidate.id === pending.fileId);
    if (!file) {
      if (loadingFiles) return;
      pendingRef.current = null;
      toast.info('That file is no longer in this folder');
      return;
    }
    pendingRef.current = null;
    if (file.name !== pending.fileName) renameFavourite(favouriteKey(pending), file.name);
    toggleFile(file);
  }, [
    allFiles,
    loadingFiles,
    loadingFolders,
    renameFavourite,
    selectContainer,
    selectedContainer,
    selectedFileArea,
    selectedProject,
    sortedFolders,
    toggleFile,
  ]);
}

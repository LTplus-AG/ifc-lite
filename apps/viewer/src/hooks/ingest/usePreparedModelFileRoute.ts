/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useCallback } from 'react';
import { cacheFileBlobs, getRecentFiles, recordRecentFiles, type RecentFileEntry } from '@/lib/recent-files';
import { resolveGltfModelFiles } from '@/services/gltf-bundle';
import { toast } from '@/components/ui/toast';

type Handles = (FileSystemFileHandle | undefined)[];
type RouteFiles = (files: File[], handles?: Handles) => void;

// Packing a bundle reads its sidecars asynchronously, so two quick picks could
// otherwise reach the loader out of order: a slow earlier Open replacing a
// later one, or added models landing in the wrong sequence. One chain shared
// by every entry point (Open, Add Model, drop) keeps routing in pick order.
let queue: Promise<void> = Promise.resolve();

/** Keep each original handle beside the same `File`; a packed GLB is synthetic and gets none. */
function alignHandles(files: readonly File[], handles: Handles | undefined, resolved: readonly File[]): Handles | undefined {
  if (!handles) return undefined;
  const byFile = new Map<File, FileSystemFileHandle | undefined>();
  files.forEach((file, index) => byFile.set(file, handles[index]));
  return resolved.map(file => byFile.get(file));
}

/** Resolve compound inputs, then hand one ordinary file per model to `route`, in pick order. */
export function prepareModelFiles(files: readonly File[], handles: Handles | undefined, route: RouteFiles, setRecentFiles?: (files: RecentFileEntry[]) => void): Promise<void> {
  const turn = queue.then(async () => {
    const resolved = await resolveGltfModelFiles(files);
    if (!resolved.length) return;
    recordRecentFiles(resolved.map(file => ({ name: file.name, size: file.size })));
    void cacheFileBlobs(resolved);
    setRecentFiles?.(getRecentFiles().slice(0, 3));
    route(resolved, alignHandles(files, handles, resolved));
  });
  // A rejected bundle is reported to its own caller and must not stall later picks.
  queue = turn.catch(() => undefined);
  return turn;
}

export function usePreparedModelFileRoute(route: RouteFiles, setRecentFiles?: (files: RecentFileEntry[]) => void): RouteFiles {
  return useCallback((files, handles) => {
    prepareModelFiles(files, handles, route, setRecentFiles).catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : String(error));
    });
  }, [route, setRecentFiles]);
}

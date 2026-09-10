/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useCallback } from 'react';
import { cacheFileBlobs, getRecentFiles, recordRecentFiles, type RecentFileEntry } from '@/lib/recent-files';
import { resolveGltfModelFiles } from '@/services/gltf-bundle';
import { toast } from '@/components/ui/toast';

type RouteFiles = (files: File[], handles?: (FileSystemFileHandle | undefined)[]) => void;

/** Resolve compound inputs, then hand one ordinary file per model to the canonical loader. */
export function usePreparedModelFileRoute(route: RouteFiles, setRecentFiles?: (files: RecentFileEntry[]) => void): RouteFiles {
  return useCallback((files, handles) => {
    void (async () => {
      try {
        const resolved = await resolveGltfModelFiles(files);
        if (!resolved.length) return;
        recordRecentFiles(resolved.map(file => ({ name: file.name, size: file.size })));
        void cacheFileBlobs(resolved);
        setRecentFiles?.(getRecentFiles().slice(0, 3));
        const unchanged = resolved.length === files.length && resolved.every((file, index) => file === files[index]);
        route(resolved, unchanged ? handles : undefined);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
    })();
  }, [route, setRecentFiles]);
}

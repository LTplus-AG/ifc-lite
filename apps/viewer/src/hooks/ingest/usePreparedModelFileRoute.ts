/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useCallback } from 'react';
import { cacheFileBlobs, getRecentFiles, recordRecentFiles, type RecentFileEntry } from '@/lib/recent-files';
import { resolveGltfModelFiles } from '@/services/gltf-bundle';
import { resolveGeoRasterBundles } from '@/lib/terrain-imagery/raster-bundle';
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
    // #5942: a georeferenced raster travels with its world file / .prj as one
    // bundle, routed AFTER the models of the same pick so a terrain dropped
    // together with its orthophoto is loaded before the image is draped on it.
    const rasters = resolveGeoRasterBundles(files);
    if (rasters.orphans.length) {
      toast.error(`${rasters.orphans.map((file) => file.name).join(', ')}: no image of the same name was selected beside it.`);
    }
    const models = await resolveGltfModelFiles(rasters.rest);
    const resolved = [...models, ...rasters.bundles];
    // Sidecars pass every entry-point filter so they can travel beside a .gltf;
    // picked on their own they resolve to nothing, which must be said, not swallowed.
    if (!resolved.length) {
      if (rasters.rest.length) {
        const images = rasters.rest.every((file) => /\.(png|jpe?g)$/i.test(file.name));
        throw new Error('Select the .gltf document together with its .bin and texture files.'
          + (images ? ' To drape a georeferenced image on a terrain, select its world file (.pgw, .jgw or .wld) with it.' : ''));
      }
      return;
    }
    // A bundle cannot be reopened from the recent list without its sidecars.
    recordRecentFiles(models.map(file => ({ name: file.name, size: file.size })));
    void cacheFileBlobs(models);
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

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useMemo, useState } from 'react';
import type { SourceContainer, SourceFile, SourceProject } from '@ifc-lite/plugin-api';
import { toast } from '@/components/ui/toast';
import { readSourceCatalogCacheOwner } from '@/lib/sources/persistence';
import {
  favouriteKey,
  loadFavourites,
  MAX_FAVOURITES_PER_PROVIDER,
  renameFavourite,
  toggleFavourite,
  type SourceFavourite,
} from '@/lib/sources/favourites';

interface UseSourceFavouritesOptions {
  providerId: string;
  selectedProject: SourceProject | null;
  selectedFileArea: SourceContainer | null;
  /** Every folder known for the area — used to label a file's own folder, which is not always the selected one. */
  folders: readonly SourceContainer[];
  /** Lets the panel re-read storage after the browser changed a favourite. */
  onChanged?: () => void;
}

/**
 * The browser's half of favourites: which of the folders and files on screen
 * are starred, and what a star press does. Storage lives in
 * `lib/sources/favourites.ts`; what is here is the wizard context a favourite
 * needs (project + file area) and the user feedback a refused write needs.
 */
export function useSourceFavourites({
  providerId,
  selectedProject,
  selectedFileArea,
  folders,
  onChanged,
}: UseSourceFavouritesOptions) {
  const [items, setItems] = useState<SourceFavourite[]>(() => loadFavourites(providerId));

  // The identity every key on this screen is scoped to. Read per render rather
  // than memoised: it is the same stamp a star press writes, and the stored
  // blob holds every account that has used this browser profile, so a key built
  // without it would match another account's record.
  const identityId = readSourceCatalogCacheOwner(providerId);

  const keys = useMemo(() => new Set(items.map((item) => favouriteKey(item))), [items]);

  const apply = useCallback(
    (favourite: SourceFavourite) => {
      const result = toggleFavourite(favourite);
      setItems(result.items);
      if (!result.ok) {
        toast.error(
          result.reason === 'cap'
            ? `Favourites are limited to ${MAX_FAVOURITES_PER_PROVIDER} per source — remove one first`
            : 'Could not save favourite — browser storage is full or unavailable',
        );
        return;
      }
      onChanged?.();
    },
    [onChanged],
  );

  const isFolderFavourite = useCallback(
    (containerId: string) =>
      selectedProject
        ? keys.has(
            favouriteKey({ providerId, projectId: selectedProject.id, kind: 'folder', containerId, identityId }),
          )
        : false,
    [identityId, keys, providerId, selectedProject],
  );

  const isFileFavourite = useCallback(
    (file: SourceFile) =>
      selectedProject
        ? keys.has(
            favouriteKey({
              providerId,
              projectId: selectedProject.id,
              kind: 'file',
              containerId: file.containerId,
              fileId: file.id,
              identityId,
            }),
          )
        : false,
    [identityId, keys, providerId, selectedProject],
  );

  const toggleFolderFavourite = useCallback(
    (container: SourceContainer) => {
      if (!selectedProject || !selectedFileArea) return;
      apply({
        providerId,
        kind: 'folder',
        projectId: selectedProject.id,
        projectName: selectedProject.name,
        fileAreaId: selectedFileArea.id,
        fileAreaName: selectedFileArea.name,
        containerId: container.id,
        containerName: container.name,
        identityId,
        addedAt: Date.now(),
      });
    },
    [apply, identityId, providerId, selectedFileArea, selectedProject],
  );

  const toggleFileFavourite = useCallback(
    (file: SourceFile) => {
      if (!selectedProject || !selectedFileArea) return;
      // `file.containerId` is the folder the file actually lives in, which for
      // a recursive provider is not the folder currently selected — a file
      // favourited from a search result must re-open its OWN folder. The name
      // is only a label; falling back to the id keeps the record complete when
      // the folder is not in the loaded listing (a search hit deeper in).
      const containerName =
        file.containerId === selectedFileArea.id
          ? selectedFileArea.name
          : (folders.find((folder) => folder.id === file.containerId)?.name ?? file.containerId);
      apply({
        providerId,
        kind: 'file',
        projectId: selectedProject.id,
        projectName: selectedProject.name,
        fileAreaId: selectedFileArea.id,
        fileAreaName: selectedFileArea.name,
        containerId: file.containerId,
        containerName,
        fileId: file.id,
        fileName: file.name,
        identityId,
        addedAt: Date.now(),
      });
    },
    [apply, folders, identityId, providerId, selectedFileArea, selectedProject],
  );

  /** Refreshes a stale label after the source renamed the folder or file underneath the favourite. */
  const rename = useCallback(
    (key: string, name: string) => {
      const next = renameFavourite(providerId, key, name);
      setItems(next);
      onChanged?.();
    },
    [onChanged, providerId],
  );

  // Memoised: the browser's favourite-jump effect lists this object in its
  // dependencies, and a fresh literal every render would re-run it every render.
  return useMemo(
    () => ({ isFolderFavourite, toggleFolderFavourite, isFileFavourite, toggleFileFavourite, rename }),
    [isFileFavourite, isFolderFavourite, rename, toggleFileFavourite, toggleFolderFavourite],
  );
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo } from 'react';
import type { SourceHost } from '@/services/sources/source-host';
import { readSourceCatalogCacheOwner } from '@/lib/sources/persistence';
import { isPrefsConfigured, loadResolvedSourcePrefs } from '@/lib/sources/preferences';
import {
  favouriteKey,
  listFavouriteProviderIds,
  loadFavourites,
  removeFavourite,
  visibleFavourites,
  type SourceFavourite,
} from '@/lib/sources/favourites';
import { FileBox, Folder, X } from 'lucide-react';

interface SourceFavouritesListProps {
  sourceHost: SourceHost;
  /** Bumped by the panel whenever a favourite is added, removed or renamed. */
  favouritesVersion: number;
  /** Bumped whenever any provider row reports a new signed-in identity. */
  identityVersion: number;
  onOpen: (favourite: SourceFavourite) => void;
  onChanged: () => void;
}

interface FavouriteRow {
  readonly favourite: SourceFavourite;
  readonly key: string;
  readonly providerTitle: string;
  /** Non-null when the row cannot be opened, and says why. */
  readonly disabledReason: string | null;
}

/**
 * The quick-access list above the provider rows: every favourited folder and
 * file the identity now signed in is allowed to see, newest first.
 *
 * Two states are rendered rather than hidden, because silently dropping a
 * bookmark is worse than showing a dead one: a provider this build no longer
 * registers, and a preference-auth provider whose required settings are
 * missing. Neither is ever deleted from storage — removal is the user's `X`.
 */
export function SourceFavouritesList({
  sourceHost,
  favouritesVersion,
  identityVersion,
  onOpen,
  onChanged,
}: SourceFavouritesListProps) {
  const rows = useMemo<FavouriteRow[]>(() => {
    // Neither counter is read directly — they exist to re-derive this list
    // after a star press elsewhere or a sign-in while the panel is open.
    void favouritesVersion;
    void identityVersion;

    const all: FavouriteRow[] = [];
    for (const providerId of listFavouriteProviderIds()) {
      const provider = sourceHost.get(providerId);
      // The stamp filter runs even for an unregistered provider: its owner key
      // outlives the plugin, so another account still must not see the rows.
      const items = visibleFavourites(loadFavourites(providerId), readSourceCatalogCacheOwner(providerId));
      if (items.length === 0) continue;

      const configured =
        provider === undefined ||
        isPrefsConfigured(provider.manifest, loadResolvedSourcePrefs(provider.manifest));
      const disabledReason = provider === undefined
        ? 'Provider unavailable'
        : configured
          ? null
          : 'Add the required settings to browse';

      for (const favourite of items) {
        all.push({
          favourite,
          key: favouriteKey(favourite),
          providerTitle: provider?.manifest.title ?? providerId,
          disabledReason,
        });
      }
    }
    return all.sort((left, right) => right.favourite.addedAt - left.favourite.addedAt);
  }, [favouritesVersion, identityVersion, sourceHost]);

  if (rows.length === 0) return null;

  return (
    <div className="border-b px-3 py-2">
      <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
        Favourites
      </div>
      <ul className="flex flex-col">
        {rows.map((row) => (
          <li key={`${row.favourite.providerId}:${row.key}`} className="flex items-center gap-1">
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2 rounded-sm px-1 py-1 text-left hover:bg-accent disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent"
              disabled={row.disabledReason !== null}
              title={row.disabledReason ?? undefined}
              onClick={() => onOpen(row.favourite)}
            >
              {row.favourite.kind === 'file' ? (
                <FileBox className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              ) : (
                <Folder className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">
                  {row.favourite.kind === 'file' ? row.favourite.fileName : row.favourite.containerName}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {row.disabledReason ??
                    `${row.providerTitle} / ${row.favourite.projectName} / ${row.favourite.fileAreaName}`}
                </span>
              </span>
            </button>
            <button
              type="button"
              className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label={`Remove favourite: ${row.favourite.kind === 'file' ? row.favourite.fileName : row.favourite.containerName}`}
              onClick={() => {
                removeFavourite(row.favourite.providerId, row.key);
                onChanged();
              }}
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

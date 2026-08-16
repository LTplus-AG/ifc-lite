/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo } from 'react';
import type { FileSourceProvider } from '@ifc-lite/plugin-api';
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
  /**
   * Signed-in identity per provider id, as the provider rows report it once
   * their auth has settled. A provider absent from the map has not settled yet.
   */
  liveIdentities: ReadonlyMap<string, string | null>;
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
 * Which identity's favourites a provider may show, or `undefined` for "its auth
 * has not settled yet, so show none".
 *
 * Live auth state wherever there is any, NOT the persisted catalog-cache stamp.
 * That stamp outlives the tab by design, so between mount and the moment
 * `restore()` settles it still names the LAST session's account: reading it
 * here put account A's folder and file names in front of whoever opened the
 * panel next. Worse, it kept them there — a restore that resolves signed-out
 * leaves the row's identity at `null`, which is what it already was on mount,
 * so the row's report never re-fires and the list never re-derived.
 */
function visibleOwner(
  providerId: string,
  provider: FileSourceProvider | undefined,
  liveIdentities: ReadonlyMap<string, string | null>,
): string | null | undefined {
  // A provider this build no longer registers has no row and so no live state.
  // Its stamp outlives the plugin, which is exactly what still keeps another
  // account's rows off screen here.
  if (provider === undefined) return readSourceCatalogCacheOwner(providerId);
  // Preference-auth providers have no identity at all and stamp `null` at
  // creation time; there is nothing to wait for.
  if (provider.manifest.auth !== 'interactive') return null;
  return liveIdentities.has(providerId) ? (liveIdentities.get(providerId) ?? null) : undefined;
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
  liveIdentities,
  onOpen,
  onChanged,
}: SourceFavouritesListProps) {
  const rows = useMemo<FavouriteRow[]>(() => {
    // The counter is not read directly — it exists to re-derive this list after
    // a star press elsewhere in the panel.
    void favouritesVersion;

    const all: FavouriteRow[] = [];
    for (const providerId of listFavouriteProviderIds()) {
      const provider = sourceHost.get(providerId);
      const owner = visibleOwner(providerId, provider, liveIdentities);
      // Auth still in flight: show nothing rather than last session's rows.
      if (owner === undefined) continue;
      const items = visibleFavourites(loadFavourites(providerId), owner);
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
  }, [favouritesVersion, liveIdentities, sourceHost]);

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

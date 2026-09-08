/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Favourited folders and files, per source provider.
 *
 * A favourite is nothing but the addressing tuple `FileSourceProvider` already
 * speaks — `projectId` / `fileAreaId` / `containerId` / `fileId`, all opaque
 * provider ids — plus the names to render and the identity that created it. No
 * provider capability is involved: re-entering a favourite is `listContainers`
 * and `listFiles` by id, which every provider already supports, so this is
 * host state exactly like the catalog cache and the downloaded-file records in
 * `persistence.ts`, and follows that module's idioms.
 *
 * Deliberately NOT stored: the revision id. A favourite is a location, not a
 * version — the live revision arrives with the listing.
 *
 * One sharp edge worth knowing before debugging a dangling favourite: ids are
 * stable across a rename on all three shipped providers, and across a move on
 * Dropbox and msgraph, but a Dalux container id is the composite
 * `${fileAreaId}::${folderId}`, so a folder moved to another file area gets a
 * new id; and a Dropbox file favourited from a SEARCH result carries a
 * path-derived `containerId` rather than an id (`searchResultContainerId`),
 * which breaks if any ancestor is renamed or moved. Both degrade to the same
 * "the folder is gone" path — the provider's own error — and are never
 * auto-deleted, because a 403 after a permission change looks identical here.
 */

export const FAVOURITES_KEY_PREFIX = 'ifc-lite-source-favourites:';
const FAVOURITES_VERSION = 1;

/** A blob this big is already unusable as a list; refuse rather than grow it. */
export const MAX_FAVOURITES_PER_PROVIDER = 200;

export type SourceFavouriteKind = 'folder' | 'file';

export interface SourceFavourite {
  readonly providerId: string;
  readonly kind: SourceFavouriteKind;
  readonly projectId: string;
  readonly projectName: string;
  /** Top-level container the browser enters; needed to re-run the wizard's second step by id. */
  readonly fileAreaId: string;
  readonly fileAreaName: string;
  /** The favourited folder, or the folder a favourited file lives in. Equals `fileAreaId` at the area root. */
  readonly containerId: string;
  readonly containerName: string;
  readonly fileId?: string;
  readonly fileName?: string;
  /**
   * Identity that created the favourite, as stamped from the provider's
   * catalog-cache owner — `null` for preference-auth providers, which never
   * write that key. The list renders only favourites whose stamp matches the
   * provider's current owner, so one browser profile cannot show account A's
   * bookmarks to account B. Storage is never filtered by it: sign back in as
   * the same account and they return.
   */
  readonly identityId: string | null;
  readonly addedAt: number;
}

interface FavouritesBlob {
  readonly version: number;
  readonly providerId: string;
  readonly items: readonly SourceFavourite[];
}

function storageKey(providerId: string): string {
  return `${FAVOURITES_KEY_PREFIX}${providerId}`;
}

/**
 * Unlike the caches in `persistence.ts` a failed favourite write IS
 * user-visible — the user pressed a star and expects it to stick — so this
 * reports failure to the caller instead of only warning.
 */
function tryWrite(key: string, value: string, what: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (err) {
    console.warn(`[sources] Failed to persist ${what} (quota exceeded or storage unavailable)`, err);
    return false;
  }
}

/**
 * Identity of a favourite for toggling and dedupe. Provider-scoped, so the same
 * file in two providers is two favourites — and identity-scoped for the same
 * reason the catalog cache is (see `syncSourceCatalogCacheOwner`): storage is
 * one blob per provider holding every account that ever used this browser
 * profile, and the provider hands the same project/folder/file ids to all of
 * them. Without the identity segment account B's star press matched account A's
 * stored record: it DELETED it instead of adding B's own, and until then the
 * folder rendered already-starred to B, who had never starred it.
 */
export function favouriteKey(
  favourite: Pick<SourceFavourite, 'providerId' | 'projectId' | 'kind' | 'containerId' | 'fileId' | 'identityId'>,
): string {
  const target = favourite.kind === 'file' ? (favourite.fileId ?? '') : favourite.containerId;
  return `${favourite.providerId}:${favourite.identityId ?? ''}:${favourite.projectId}:${favourite.kind}:${target}`;
}

/** Per-record validation, so one hand-edited or older-build entry drops out instead of taking the whole list with it. */
function parseFavourite(value: unknown, providerId: string): SourceFavourite | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Partial<SourceFavourite>;
  if (
    record.providerId !== providerId ||
    (record.kind !== 'folder' && record.kind !== 'file') ||
    typeof record.projectId !== 'string' ||
    typeof record.projectName !== 'string' ||
    typeof record.fileAreaId !== 'string' ||
    typeof record.fileAreaName !== 'string' ||
    typeof record.containerId !== 'string' ||
    typeof record.containerName !== 'string' ||
    typeof record.addedAt !== 'number' ||
    !(typeof record.identityId === 'string' || record.identityId === null)
  ) {
    return null;
  }
  if (record.kind === 'file' && (typeof record.fileId !== 'string' || typeof record.fileName !== 'string')) {
    return null;
  }
  return {
    providerId,
    kind: record.kind,
    projectId: record.projectId,
    projectName: record.projectName,
    fileAreaId: record.fileAreaId,
    fileAreaName: record.fileAreaName,
    containerId: record.containerId,
    containerName: record.containerName,
    // Only on a file favourite: a folder record carrying `fileId: undefined`
    // is a different object shape from the one that was stored, which a
    // deep-equality check downstream would notice.
    ...(record.kind === 'file' ? { fileId: record.fileId, fileName: record.fileName } : {}),
    identityId: record.identityId,
    addedAt: record.addedAt,
  };
}

/** Newest first — the only order this feature has; see the design's out-of-scope list. */
function byAddedAtDesc(left: SourceFavourite, right: SourceFavourite): number {
  return right.addedAt - left.addedAt;
}

export function loadFavourites(providerId: string): SourceFavourite[] {
  try {
    const raw = localStorage.getItem(storageKey(providerId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Partial<FavouritesBlob>;
    if (parsed.version !== FAVOURITES_VERSION || !Array.isArray(parsed.items)) return [];
    return parsed.items
      .flatMap((item) => {
        const favourite = parseFavourite(item, providerId);
        return favourite ? [favourite] : [];
      })
      .sort(byAddedAtDesc);
  } catch (err) {
    console.warn(`[sources] Failed to parse favourites for "${providerId}"`, err);
    return [];
  }
}

/** Returns false when the write failed (quota, private mode) so the caller can tell the user. */
export function saveFavourites(providerId: string, items: readonly SourceFavourite[]): boolean {
  const blob: FavouritesBlob = { version: FAVOURITES_VERSION, providerId, items: [...items] };
  return tryWrite(storageKey(providerId), JSON.stringify(blob), `favourites for "${providerId}"`);
}

export function isFavourited(items: readonly SourceFavourite[], key: string): boolean {
  return items.some((item) => favouriteKey(item) === key);
}

/** Provider ids with a stored favourites blob, including providers no longer registered in this build. */
export function listFavouriteProviderIds(): string[] {
  const ids: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(FAVOURITES_KEY_PREFIX)) ids.push(key.slice(FAVOURITES_KEY_PREFIX.length));
    }
  } catch (err) {
    console.warn('[sources] Failed to enumerate stored favourites', err);
  }
  return ids.sort();
}

export interface ToggleFavouriteResult {
  /** True when the favourite was added, false when it was removed or refused. */
  readonly added: boolean;
  /** False when nothing was persisted — a full/unavailable storage, or the per-provider cap. */
  readonly ok: boolean;
  readonly items: SourceFavourite[];
  readonly reason?: 'storage' | 'cap';
}

export function toggleFavourite(favourite: SourceFavourite): ToggleFavouriteResult {
  const key = favouriteKey(favourite);
  const items = loadFavourites(favourite.providerId);
  const remaining = items.filter((item) => favouriteKey(item) !== key);

  if (remaining.length !== items.length) {
    const ok = saveFavourites(favourite.providerId, remaining);
    return { added: false, ok, items: ok ? remaining : items, reason: ok ? undefined : 'storage' };
  }

  if (items.length >= MAX_FAVOURITES_PER_PROVIDER) {
    return { added: false, ok: false, items, reason: 'cap' };
  }

  const next = [favourite, ...items].sort(byAddedAtDesc);
  const ok = saveFavourites(favourite.providerId, next);
  return { added: ok, ok, items: ok ? next : items, reason: ok ? undefined : 'storage' };
}

export function removeFavourite(providerId: string, key: string): SourceFavourite[] {
  const items = loadFavourites(providerId);
  const remaining = items.filter((item) => favouriteKey(item) !== key);
  if (remaining.length === items.length) return items;
  return saveFavourites(providerId, remaining) ? remaining : items;
}

/**
 * Refreshes the stored display name after the source renamed the folder or
 * file underneath us. Ids address the favourite, so a rename never breaks it —
 * only the label goes stale, and this is where the fresh one arrives.
 */
export function renameFavourite(providerId: string, key: string, name: string): SourceFavourite[] {
  const items = loadFavourites(providerId);
  let changed = false;
  const next = items.map((item) => {
    if (favouriteKey(item) !== key) return item;
    const current = item.kind === 'file' ? item.fileName : item.containerName;
    if (current === name) return item;
    changed = true;
    return item.kind === 'file' ? { ...item, fileName: name } : { ...item, containerName: name };
  });
  if (!changed) return items;
  return saveFavourites(providerId, next) ? next : items;
}

/**
 * Favourites the identity now signed in is allowed to see. `currentOwner` is
 * the provider's catalog-cache owner (`readSourceCatalogCacheOwner`), which is
 * `null` both for a signed-out interactive provider and for a preference-auth
 * one — the latter stamps `null` at creation time too, so its favourites match.
 */
export function visibleFavourites(
  items: readonly SourceFavourite[],
  currentOwner: string | null,
): SourceFavourite[] {
  return items.filter((item) => item.identityId === currentOwner);
}

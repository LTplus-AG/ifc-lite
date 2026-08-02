/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SourceContainer, SourceFile, SourceTag } from '@ifc-lite/plugin-api';
import { clearSourcePrefs } from './preferences';

const CATALOG_KEY_PREFIX = 'ifc-lite-source-catalog:';
const DOWNLOADED_FILES_KEY = 'ifc-lite-downloaded-source-files';
const WATCH_CURSOR_KEY_PREFIX = 'ifc-lite-source-watch:';
/** Prefix `createNamespacedStorage` (services/sources/host-storage.ts) uses for
 *  a provider's own `ctx.storage` keys. Mirrored here so "forget saved values"
 *  can sweep them; the conformance of the two constants is asserted by
 *  `persistence.test.ts`. */
const PROVIDER_STORAGE_KEY_PREFIX = 'ifc-lite-source:';
const STORAGE_VERSION = 2;

export interface SourceCatalogCacheEntry {
  readonly version: number;
  readonly providerId: string;
  readonly projectId: string;
  readonly fileAreaId: string;
  readonly updatedAt: number;
  readonly folders: readonly SourceContainer[];
  readonly files: readonly SourceFile[];
}

export interface DownloadedSourceFileRecord {
  readonly providerId: string;
  readonly projectId: string;
  readonly containerId: string;
  readonly fileId: string;
  readonly name: string;
  readonly loadedRevisionId: string;
  readonly sizeBytes?: number;
  readonly loadedAt: number;
}

export type DownloadedSourceFileStatus =
  | 'never-loaded'
  | 'loaded-current'
  | 'update-available';

/**
 * Best-effort localStorage write. Persistence here is an optimisation (caches,
 * "already downloaded" markers), never load-bearing — a `QuotaExceededError`
 * or a locked-down/private-mode storage must degrade to "not persisted this
 * session" with a warning, not abort the sync or download that triggered it.
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

/** Minimum shape the catalog UI dereferences on a cached container. */
function isSourceContainerish(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === 'string' && typeof o.name === 'string';
}

/** Minimum shape the catalog UI dereferences on a cached file. */
function isSourceFileish(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === 'string' && typeof o.name === 'string'
    && typeof o.currentRevisionId === 'string';
}

export function loadSourceCatalogCache(
  providerId: string,
  projectId: string,
  fileAreaId: string,
): SourceCatalogCacheEntry | null {
  try {
    const raw = localStorage.getItem(
      `${CATALOG_KEY_PREFIX}${providerId}:${projectId}:${fileAreaId}`,
    );
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SourceCatalogCacheEntry>;
    if (
      parsed.version !== STORAGE_VERSION ||
      parsed.providerId !== providerId ||
      parsed.projectId !== projectId ||
      parsed.fileAreaId !== fileAreaId ||
      !Array.isArray(parsed.folders) ||
      !Array.isArray(parsed.files) ||
      typeof parsed.updatedAt !== 'number'
    ) {
      return null;
    }
    // Shape-check the ELEMENTS, not just the arrays. localStorage survives
    // across app versions, so a cache written by an older build (or edited by
    // hand) can hold entries missing fields the UI dereferences — the
    // downloaded-file loader below already validates per-record for this
    // reason, and the catalog path should not be the weaker one.
    if (!parsed.folders.every(isSourceContainerish) || !parsed.files.every(isSourceFileish)) {
      return null;
    }
    return {
      version: STORAGE_VERSION,
      providerId,
      projectId,
      fileAreaId,
      updatedAt: parsed.updatedAt,
      folders: parsed.folders,
      files: parsed.files,
    };
  } catch (err) {
    console.warn(`Failed to parse source catalog cache for "${providerId}"`, err);
    return null;
  }
}

/**
 * Persists a fully-fetched file-area catalog. Returns the entry either way —
 * a failed write (quota) only means the cache misses next session.
 */
export function saveSourceCatalogCache(
  providerId: string,
  projectId: string,
  fileAreaId: string,
  folders: readonly SourceContainer[],
  files: readonly SourceFile[],
): SourceCatalogCacheEntry {
  const entry: SourceCatalogCacheEntry = {
    version: STORAGE_VERSION,
    providerId,
    projectId,
    fileAreaId,
    updatedAt: Date.now(),
    folders: [...folders],
    files: [...files],
  };
  tryWrite(
    `${CATALOG_KEY_PREFIX}${providerId}:${projectId}:${fileAreaId}`,
    JSON.stringify(entry),
    `catalog cache for "${providerId}"`,
  );
  return entry;
}

export function makeDownloadedSourceFileKey(
  providerId: string,
  projectId: string,
  fileId: string,
): string {
  return `${providerId}:${projectId}:${fileId}`;
}

export function loadDownloadedSourceFileRecords(): Map<string, DownloadedSourceFileRecord> {
  try {
    const raw = localStorage.getItem(DOWNLOADED_FILES_KEY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Map();
    const entries = parsed.flatMap((entry) => {
      const record = entry as Partial<DownloadedSourceFileRecord>;
      if (
        typeof record.providerId !== 'string' ||
        typeof record.projectId !== 'string' ||
        typeof record.fileId !== 'string' ||
        typeof record.containerId !== 'string' ||
        typeof record.name !== 'string' ||
        typeof record.loadedRevisionId !== 'string' ||
        typeof record.loadedAt !== 'number'
      ) {
        return [];
      }
      return [[
        makeDownloadedSourceFileKey(
          record.providerId,
          record.projectId,
          record.fileId,
        ),
        {
          providerId: record.providerId,
          projectId: record.projectId,
          containerId: record.containerId,
          fileId: record.fileId,
          name: record.name,
          loadedRevisionId: record.loadedRevisionId,
          sizeBytes: record.sizeBytes,
          loadedAt: record.loadedAt,
        } satisfies DownloadedSourceFileRecord,
      ] as const];
    });
    return new Map(entries);
  } catch (err) {
    console.warn('Failed to parse downloaded source file records', err);
    return new Map();
  }
}

export function saveDownloadedSourceFileRecords(
  records: ReadonlyMap<string, DownloadedSourceFileRecord>,
): void {
  tryWrite(
    DOWNLOADED_FILES_KEY,
    JSON.stringify([...records.values()]),
    'downloaded source-file records',
  );
}

export function recordDownloadedSourceFile(
  tag: SourceTag,
  sourceFile: SourceFile,
): DownloadedSourceFileRecord {
  const records = loadDownloadedSourceFileRecords();
  const record: DownloadedSourceFileRecord = {
    providerId: tag.provider,
    projectId: tag.projectId,
    containerId: sourceFile.containerId,
    fileId: sourceFile.id,
    name: sourceFile.name,
    loadedRevisionId: tag.revisionId,
    sizeBytes: sourceFile.sizeBytes,
    loadedAt: tag.loadedAt,
  };
  records.set(
    makeDownloadedSourceFileKey(tag.provider, tag.projectId, sourceFile.id),
    record,
  );
  saveDownloadedSourceFileRecords(records);
  return record;
}

export function getDownloadedSourceFileRecord(
  records: ReadonlyMap<string, DownloadedSourceFileRecord>,
  providerId: string,
  projectId: string,
  fileId: string,
): DownloadedSourceFileRecord | undefined {
  return records.get(makeDownloadedSourceFileKey(providerId, projectId, fileId));
}

export function getDownloadedSourceFileStatus(
  file: SourceFile,
  record?: DownloadedSourceFileRecord,
): DownloadedSourceFileStatus {
  if (!record) return 'never-loaded';
  return record.loadedRevisionId === file.currentRevisionId
    ? 'loaded-current'
    : 'update-available';
}

// ---------------------------------------------------------------------------
// watchRevisions cursor — persisted per provider + project so change
// detection resumes from the provider's delta cursor instead of re-sweeping.
// ---------------------------------------------------------------------------

export function loadRevisionWatchCursor(providerId: string, projectId: string): string | undefined {
  try {
    return localStorage.getItem(`${WATCH_CURSOR_KEY_PREFIX}${providerId}:${projectId}`) ?? undefined;
  } catch (err) {
    console.warn('[sources] Failed to read revision-watch cursor', err);
    return undefined;
  }
}

export function saveRevisionWatchCursor(
  providerId: string,
  projectId: string,
  cursor: string | undefined,
): void {
  const key = `${WATCH_CURSOR_KEY_PREFIX}${providerId}:${projectId}`;
  if (cursor === undefined) {
    try {
      localStorage.removeItem(key);
    } catch (err) {
      console.warn('[sources] Failed to clear revision-watch cursor', err);
    }
    return;
  }
  tryWrite(key, cursor, 'revision-watch cursor');
}

// ---------------------------------------------------------------------------
// Forget-everything sweep
// ---------------------------------------------------------------------------

/**
 * Removes every piece of persistent state the sources feature owns for one
 * provider: saved preferences (API keys), catalog caches, downloaded-file
 * records, revision-watch cursors, and the provider's own `ctx.storage`
 * namespace. This is what "Forget saved values" must mean on a shared
 * machine — not just the prefs key.
 */
export function clearAllSourceData(providerId: string): void {
  clearSourcePrefs(providerId);

  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      if (
        key.startsWith(`${CATALOG_KEY_PREFIX}${providerId}:`) ||
        key.startsWith(`${WATCH_CURSOR_KEY_PREFIX}${providerId}:`) ||
        key.startsWith(`${PROVIDER_STORAGE_KEY_PREFIX}${providerId}:`)
      ) {
        doomed.push(key);
      }
    }
    for (const key of doomed) localStorage.removeItem(key);
  } catch (err) {
    console.warn(`[sources] Failed to sweep stored data for "${providerId}"`, err);
  }

  const records = loadDownloadedSourceFileRecords();
  let changed = false;
  for (const [key, record] of records) {
    if (record.providerId === providerId) {
      records.delete(key);
      changed = true;
    }
  }
  if (changed) saveDownloadedSourceFileRecords(records);
}

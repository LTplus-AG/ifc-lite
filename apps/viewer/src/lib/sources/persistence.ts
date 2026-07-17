/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SourceContainer, SourceFile, SourceTag } from '@ifc-lite/plugin-api';

const CATALOG_KEY_PREFIX = 'ifc-lite-source-catalog:';
const DOWNLOADED_FILES_KEY = 'ifc-lite-downloaded-source-files';
const STORAGE_VERSION = 1;

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
  readonly loadedRevisionVersion: number;
  readonly sizeBytes?: number;
  readonly loadedAt: number;
}

export type DownloadedSourceFileStatus =
  | 'never-loaded'
  | 'loaded-current'
  | 'update-available';

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
  localStorage.setItem(
    `${CATALOG_KEY_PREFIX}${providerId}:${projectId}:${fileAreaId}`,
    JSON.stringify(entry),
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
        typeof record.loadedRevisionVersion !== 'number' ||
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
          loadedRevisionVersion: record.loadedRevisionVersion,
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
  localStorage.setItem(
    DOWNLOADED_FILES_KEY,
    JSON.stringify([...records.values()]),
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
    loadedRevisionVersion: sourceFile.revisions[0]?.version ?? 1,
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

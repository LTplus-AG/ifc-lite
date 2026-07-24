/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { matchesGlob } from '@ifc-lite/plugin-api';
import type { FileFilter, SourceContainer, SourceFile, SourceProject, SourceRevision } from '@ifc-lite/plugin-api';

import { encodeContainerId } from './ids.js';
import type { GraphDrive, GraphDriveItem, GraphDriveItemVersion, GraphSite } from './graph-types.js';

/**
 * The host always passes an explicit `namePatterns` filter (see the viewer's
 * `IFC_NAME_PATTERNS`), but this provider's own search fallback and its tests
 * need the same default so a bare `searchFiles(ctx, projectId, 'ifc')` call
 * doesn't hand back every STEP-text false positive Graph's content search
 * turns up.
 */
export const DEFAULT_IFC_NAME_PATTERNS: readonly string[] = ['*.ifc', '*.ifcx', '*.ifc5'];

/** Used by `listFiles`/`listContainers`: no filter means "everything", matching every other provider's convention. */
export function matchesNameFilter(name: string, filter?: FileFilter): boolean {
  if (!filter?.namePatterns?.length) return true;
  return filter.namePatterns.some((pattern) => matchesGlob(name, pattern));
}

/**
 * Used by `searchFiles` only: Graph's search endpoint matches file *content*,
 * not just names, so an absent filter must still fall back to IFC-shaped
 * name patterns — otherwise `searchFiles(ctx, projectId, 'ifc')` would hand
 * back every `.docx`/`.pdf` whose text happens to mention "ifc".
 */
export function matchesSearchNameFilter(name: string, filter?: FileFilter): boolean {
  const patterns = filter?.namePatterns?.length ? filter.namePatterns : DEFAULT_IFC_NAME_PATTERNS;
  return patterns.some((pattern) => matchesGlob(name, pattern));
}

export function matchesMimeFilter(mimeType: string | undefined, filter?: FileFilter): boolean {
  if (!filter?.mimeTypes?.length) return true;
  // Advisory only — IFC files routinely arrive as octet-stream, so an absent
  // mimeType must not be treated as a rejection.
  if (!mimeType) return true;
  return filter.mimeTypes.includes(mimeType);
}

export function driveToContainer(drive: GraphDrive): SourceContainer {
  return {
    id: drive.id,
    name: drive.name ?? 'Documents',
    hasChildren: undefined,
    meta: { kind: 'drive', driveType: drive.driveType },
  };
}

export function driveItemToContainer(
  driveId: string,
  parentContainerId: string,
  item: GraphDriveItem,
): SourceContainer {
  return {
    id: encodeContainerId(driveId, item.id),
    name: item.name ?? item.id,
    parentId: parentContainerId,
    hasChildren: item.folder ? (item.folder.childCount ?? 0) > 0 : false,
    meta: { kind: 'folder' },
  };
}

export function driveItemToFile(containerId: string, item: GraphDriveItem): SourceFile {
  return {
    id: item.id,
    name: item.name ?? item.id,
    containerId,
    mimeType: item.file?.mimeType,
    sizeBytes: item.size,
    // Graph's `cTag` changes on content change only (not on metadata-only
    // changes like a rename), which is exactly the revision-identity
    // contract the host expects. Fall back to `eTag` for the rare item that
    // doesn't expose one.
    currentRevisionId: item.cTag ?? item.eTag ?? item.id,
    modifiedAt: item.lastModifiedDateTime,
    modifiedBy: item.lastModifiedBy?.user?.displayName,
    meta: { kind: 'file' },
  };
}

export function siteToProject(site: GraphSite, idPrefix: string): SourceProject {
  return {
    id: `${idPrefix}${site.id}`,
    name: site.displayName ?? site.name ?? site.id,
    description: site.webUrl,
    meta: { kind: 'site', webUrl: site.webUrl },
  };
}

export function versionToRevision(version: GraphDriveItemVersion): SourceRevision {
  return {
    id: version.id,
    label: `Version ${version.id}`,
    createdAt: version.lastModifiedDateTime ?? new Date(0).toISOString(),
    createdBy: version.lastModifiedBy?.user?.displayName,
    sizeBytes: version.size,
  };
}

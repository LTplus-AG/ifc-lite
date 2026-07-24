/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// ============================================================================
// Composite ids.
//
// Graph item ids are only unique *within* a drive (a site can have several
// document libraries, a user can have several drives), so every container
// this provider hands back must carry its owning drive id. Rather than a
// side-table mapping container id -> drive id (which the plugin-api's own
// SourceFileRef design was explicitly built to avoid — see types.ts), the
// drive id is encoded directly into the opaque container id string. The host
// never inspects a container id, so this is safe.
//
// Top-level containers (drives themselves) are just the bare drive id.
// Folder containers are `${driveId}${SEPARATOR}${itemId}`. Files always sit
// *inside* a container, so a file's `containerId` (from SourceFile /
// SourceFileRef) already carries the drive id — a bare file id never needs
// one of its own.
// ============================================================================

const SEPARATOR = '::';

export interface DriveLocation {
  readonly driveId: string;
  /** `undefined` when the location is the drive root itself. */
  readonly itemId?: string;
}

export function encodeContainerId(driveId: string, itemId?: string): string {
  if (driveId.includes(SEPARATOR)) {
    throw new Error(`Graph drive id unexpectedly contains "${SEPARATOR}": ${driveId}`);
  }
  return itemId === undefined ? driveId : `${driveId}${SEPARATOR}${itemId}`;
}

/** Splits a container id back into its drive id and, if present, item id. */
export function decodeContainerId(containerId: string): DriveLocation {
  const at = containerId.indexOf(SEPARATOR);
  if (at === -1) return { driveId: containerId };
  return {
    driveId: containerId.slice(0, at),
    itemId: containerId.slice(at + SEPARATOR.length),
  };
}

/** Children-listing endpoint for a container: drive root, or a specific folder item. */
export function childrenEndpoint(containerId: string): string {
  const { driveId, itemId } = decodeContainerId(containerId);
  return itemId === undefined
    ? `/drives/${encodeURIComponent(driveId)}/root/children`
    : `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/children`;
}

export const PROJECT_ONEDRIVE_PREFIX = 'onedrive:';
export const PROJECT_SITE_PREFIX = 'site:';

export function onedriveProjectId(driveOwnerId: string): string {
  return `${PROJECT_ONEDRIVE_PREFIX}${driveOwnerId}`;
}

export function siteProjectId(siteId: string): string {
  return `${PROJECT_SITE_PREFIX}${siteId}`;
}

export function isOnedriveProject(projectId: string): boolean {
  return projectId.startsWith(PROJECT_ONEDRIVE_PREFIX);
}

export function projectSiteId(projectId: string): string | undefined {
  return projectId.startsWith(PROJECT_SITE_PREFIX) ? projectId.slice(PROJECT_SITE_PREFIX.length) : undefined;
}

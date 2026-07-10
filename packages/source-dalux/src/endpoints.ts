/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Dalux Build API endpoint paths. Pinned versions isolate the provider from
 * Dalux's rolling version bumps — update here when a new version is confirmed.
 */

const BASE = 'https://field.dalux.com/api';

export const ENDPOINTS = {
  projects: () => `${BASE}/projects` as const,

  fileAreas: (projectId: string) =>
    `${BASE}/projects/${enc(projectId)}/file_areas` as const,

  folders: (projectId: string, fileAreaId: string) =>
    `${BASE}/v2/projects/${enc(projectId)}/file_areas/${enc(fileAreaId)}/folders` as const,

  files: (projectId: string, fileAreaId: string) =>
    `${BASE}/v2/projects/${enc(projectId)}/file_areas/${enc(fileAreaId)}/files` as const,

  fileDownload: (projectId: string, fileAreaId: string, fileId: string) =>
    `${BASE}/v2/projects/${enc(projectId)}/file_areas/${enc(fileAreaId)}/files/${enc(fileId)}/download` as const,

  revisionDownload: (projectId: string, fileAreaId: string, fileId: string, revisionId: string) =>
    `${BASE}/v2/projects/${enc(projectId)}/file_areas/${enc(fileAreaId)}/files/${enc(fileId)}/revisions/${enc(revisionId)}/download` as const,
} as const;

function enc(segment: string): string {
  return encodeURIComponent(segment);
}

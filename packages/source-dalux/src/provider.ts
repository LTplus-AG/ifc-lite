/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/// <reference path="./dalux-build-api.d.ts" />

import ProjectsApi from 'dalux-build-api/src/api/ProjectsApi.js';
import FileAreasApi from 'dalux-build-api/src/api/FileAreasApi.js';
import { convertToModel, convertToModelList } from 'dalux-build-api/src/models/convert.js';
import { FileSchema, FileResponseSchema } from 'dalux-build-api/src/models/files/index.js';
import { FolderSchema } from 'dalux-build-api/src/models/folders/index.js';

import type { DaluxFile, DaluxFileResponse } from 'dalux-build-api/src/models/files/index.js';
import type { DaluxFolder } from 'dalux-build-api/src/models/folders/index.js';

import type {
  ConnectionTestResult,
  FileFilter,
  FileSourceProvider,
  PluginContext,
  RevisionEvent,
  SourceContainer,
  SourceFile,
  SourceProject,
  SourceRevision,
} from '@ifc-lite/plugin-api';

import { DALUX_MANIFEST } from './manifest.js';

const DEFAULT_BASE_URL = 'https://node1.field.dalux.com/service/api';

interface ContainerLocation {
  projectId: string;
  fileAreaId: string;
  folderId?: string;
}

interface DaluxCredentials {
  readonly baseUrl: string;
  readonly apiKey: string;
}

interface DaluxPageLink {
  readonly rel: string;
  readonly href: string;
}

interface DaluxPage {
  readonly items?: readonly unknown[];
  readonly metadata?: { readonly totalRemainingItems?: number };
  readonly links?: readonly DaluxPageLink[];
}

/**
 * Follows bookmark pagination across every page of a Dalux list endpoint.
 *
 * Deliberately doesn't reuse `dalux-build-api`'s own `getAllFiles`/
 * `getAllFolders`/`utils/pagination.js`: those read each page as
 * `response.items` only, without the bare-array normalization the
 * library's own `listResponseSchema` applies for single-page reads: an
 * endpoint that responds with a bare array instead of the
 * `{ items, metadata, links }` envelope would silently paginate to zero
 * results. This treats both shapes as equivalent.
 */
async function fetchAllPages(
  client: BrowserDaluxApiClient,
  endpoint: string,
  params: Record<string, unknown> = {},
): Promise<unknown[]> {
  const items: unknown[] = [];
  let currentParams = { ...params };
  const seenBookmarks = new Set<string>();
  let pageIndex = 0;

  for (;;) {
    const response = await client.get(endpoint, currentParams);
    const page: DaluxPage = Array.isArray(response)
      ? { items: response }
      : ((response as DaluxPage | null) ?? {});
    const pageItems = page.items ?? [];
    pageIndex += 1;
    client.debug('page received', {
      endpoint,
      pageIndex,
      params: currentParams,
      itemCount: pageItems.length,
      remaining: page.metadata?.totalRemainingItems ?? 0,
      links: (page.links ?? []).map((link) => link.rel),
      bareArray: Array.isArray(response),
    });
    items.push(...pageItems);

    const remaining = page.metadata?.totalRemainingItems ?? 0;
    const nextLink = (page.links ?? []).find((link) => link.rel === 'nextPage');
    if (!pageItems.length || remaining === 0 || !nextLink) {
      client.debug('pagination complete', {
        endpoint,
        pageIndex,
        totalItems: items.length,
        stopReason: !pageItems.length
          ? 'empty-page'
          : remaining === 0
            ? 'no-remaining-items'
            : 'no-next-link',
      });
      break;
    }

    const bookmark = new URL(nextLink.href).searchParams.get('bookmark');
    if (!bookmark || seenBookmarks.has(bookmark)) {
      client.debug('pagination stopped before next page', {
        endpoint,
        pageIndex,
        bookmark,
        duplicateBookmark: Boolean(bookmark && seenBookmarks.has(bookmark)),
      });
      break;
    }
    seenBookmarks.add(bookmark);
    currentParams = { ...params, bookmark };
  }

  return items;
}

class BrowserDaluxApiClient {
  constructor(
    private readonly credentials: DaluxCredentials,
    private readonly ctx: PluginContext,
  ) {}

  debug(message: string, details?: Record<string, unknown>): void {
    this.ctx.log.debug(`Dalux ${message}`, details ?? {});
  }

  async get(path: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const url = new URL(
      path.startsWith('/')
        ? `${this.credentials.baseUrl}${path}`
        : path,
    );
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }

    this.debug('GET request', { url: url.toString(), params });
    const response = await this.ctx.fetch(url.toString(), {
      headers: {
        'X-API-KEY': this.credentials.apiKey,
        Accept: 'application/json',
      },
    });
    this.debug('GET response', {
      url: url.toString(),
      status: response.status,
      ok: response.ok,
      contentType: response.headers.get('content-type'),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      this.ctx.log.error('Dalux GET failed', {
        url: url.toString(),
        status: response.status,
        statusText: response.statusText,
        body,
      });
      throw new Error(`Dalux API ${response.status}: ${response.statusText} — ${body}`);
    }

    return response.json() as Promise<unknown>;
  }

  async getBinary(url: string): Promise<ArrayBuffer> {
    this.debug('binary GET request', { url });
    const response = await this.ctx.fetch(url, {
      headers: {
        'X-API-KEY': this.credentials.apiKey,
        Accept: '*/*',
      },
    });
    this.debug('binary GET response', {
      url,
      status: response.status,
      ok: response.ok,
      contentType: response.headers.get('content-type'),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      this.ctx.log.error('Dalux binary GET failed', {
        url,
        status: response.status,
        statusText: response.statusText,
        body,
      });
      throw new Error(`Dalux API ${response.status}: ${response.statusText} — ${body}`);
    }

    return response.arrayBuffer();
  }
}

export class DaluxBuildProvider implements FileSourceProvider {
  readonly manifest = DALUX_MANIFEST;

  async listProjects(ctx: PluginContext): Promise<SourceProject[]> {
    const api = await this.createApi(ctx);
    const { items } = await api.projects.listProjects();
    return items.map((project) => ({ id: project.projectId, name: project.projectName }));
  }

  async listContainers(
    ctx: PluginContext,
    projectId: string,
    parentId?: string,
  ): Promise<SourceContainer[]> {
    ctx.log.debug('listContainers start', { projectId, parentId });
    const api = await this.createApi(ctx);

    if (!parentId) {
      // Top level: just the file areas. Cheap — no folder walk, so the host
      // can show this list immediately instead of waiting on every file
      // area's (potentially deep) folder tree up front.
      const { items: fileAreas } = await api.fileAreas.getFileAreas(projectId);

      const containers: SourceContainer[] = [];
      for (const fileArea of fileAreas) {
        await this.storeContainerLocation(ctx, fileArea.fileAreaId, {
          projectId,
          fileAreaId: fileArea.fileAreaId,
        });
        containers.push({
          id: fileArea.fileAreaId,
          name: fileArea.fileAreaName,
          meta: { kind: 'file-area' },
        });
      }
      return containers;
    }

    // Scoped to one file area (or a folder within it) — resolve which file
    // area owns it, then fetch its folders.
    const location = await this.resolveContainerLocation(ctx, parentId);
    const fileAreaId = location?.fileAreaId ?? parentId;

    // Every folder in the file area (nested levels included) — the
    // `parentFolderId` param doesn't filter server-side, it just echoes
    // back the same full result.
    const rawFolders = await fetchAllPages(
      api.client,
      `/5.1/projects/${projectId}/file_areas/${fileAreaId}/folders`,
    );
    const folders = convertToModelList<DaluxFolder>(rawFolders, FolderSchema, 'Folder');
    const folderIds = new Set(folders.map((folder) => folder.folderId));

    const containers: SourceContainer[] = [];
    for (const folder of folders) {
      await this.storeContainerLocation(ctx, folder.folderId, { projectId, fileAreaId, folderId: folder.folderId });
      const parentFolderId = nonEmptyString(folder.parentFolderId);
      const resolvedParentId = !parentFolderId || parentFolderId === fileAreaId || folderIds.has(parentFolderId)
        ? (parentFolderId ?? fileAreaId)
        : fileAreaId;
      containers.push({
        id: folder.folderId,
        name: folder.folderName,
        parentId: resolvedParentId,
        meta: { kind: 'folder', fileAreaId },
      });
    }
    ctx.log.debug('listContainers folder structure', {
      projectId,
      fileAreaId,
      folderCount: containers.length,
      sample: containers.slice(0, 50).map((container) => ({
        id: container.id,
        name: container.name,
        parentId: container.parentId,
      })),
    });
    for (const container of containers.slice(0, 50)) {
      ctx.log.debug('listContainers folder row', {
        projectId,
        fileAreaId,
        id: container.id,
        name: container.name,
        parentId: container.parentId,
      });
    }
    return containers;
  }

  /** Every container in a project — file areas plus all of their folders. */
  private async listAllContainers(
    ctx: PluginContext,
    projectId: string,
  ): Promise<SourceContainer[]> {
    const fileAreas = await this.listContainers(ctx, projectId);
    const all = [...fileAreas];
    for (const fileArea of fileAreas) {
      all.push(...(await this.listContainers(ctx, projectId, fileArea.id)));
    }
    return all;
  }

  async listFiles(
    ctx: PluginContext,
    containerId: string,
    filter?: FileFilter,
  ): Promise<SourceFile[]> {
    ctx.log.debug('listFiles start', { containerId, filter });
    const location = await this.resolveContainerLocation(ctx, containerId);
    if (!location) return [];

    const api = await this.createApi(ctx);

    // `FilesApi.getAllFiles` itself isn't imported here — its module also
    // pulls in Node-only download helpers (`fs`/`path`/`readline`/`axios`)
    // that break browser bundling.
    const rawItems = await fetchAllPages(
      api.client,
      `/6.1/projects/${location.projectId}/file_areas/${location.fileAreaId}/files`,
      location.folderId ? { folderId: location.folderId } : {},
    );
    const daluxFiles = convertToModelList<DaluxFile>(rawItems, FileSchema, 'File');
    const nonDeletedFiles = daluxFiles.filter((file) => !file.deleted);

    let files = nonDeletedFiles.map((file) => toSourceFile(location.fileAreaId, file));

    // The Dalux `files` endpoint doesn't reliably scope to the requested
    // folder — it can return every file in the file area regardless of the
    // `folderId` query param. Trust each file's own `folderId` instead of
    // the endpoint's filtering.
    //
    // For an actual folder selection we keep the view strict to that folder.
    // For a file-area selection, surface every descendant file in the area:
    // the browser already shows the folder tree separately, and Dalux areas
    // commonly contain IFCs only inside subfolders rather than at the root.
    const beforeContainerFilter = files.length;
    if (location.folderId) {
      files = files.filter((file) => file.containerId === containerId);
    }
    const afterContainerFilter = files.length;

    for (const file of files) {
      await ctx.storage.set(
        `file-loc:${file.id}`,
        JSON.stringify({
          projectId: location.projectId,
          fileAreaId: location.fileAreaId,
        }),
      );
    }

    if (filter?.namePatterns?.length) {
      const beforeNameFilter = files.length;
      files = files.filter((file) =>
        filter.namePatterns!.some((pattern) => matchGlob(pattern, file.name)),
      );
      ctx.log.debug('listFiles name filter applied', {
        containerId,
        patterns: filter.namePatterns,
        before: beforeNameFilter,
        after: files.length,
        sampleNames: files.slice(0, 5).map((file) => file.name),
      });
    }
    if (filter?.mimeTypes?.length) {
      const beforeMimeFilter = files.length;
      files = files.filter(
        (file) => file.mimeType && filter.mimeTypes!.includes(file.mimeType),
      );
      ctx.log.debug('listFiles mime filter applied', {
        containerId,
        mimeTypes: filter.mimeTypes,
        before: beforeMimeFilter,
        after: files.length,
      });
    }

    ctx.log.debug('listFiles complete', {
      containerId,
      projectId: location.projectId,
      fileAreaId: location.fileAreaId,
      folderId: location.folderId,
      rawCount: rawItems.length,
      parsedCount: daluxFiles.length,
      nonDeletedCount: nonDeletedFiles.length,
      beforeContainerFilter,
      afterContainerFilter,
      count: files.length,
      sampleContainerIds: nonDeletedFiles.slice(0, 5).map((file) => file.folderId ?? location.fileAreaId),
      sampleNames: nonDeletedFiles.slice(0, 5).map((file) => file.fileName),
    });

    return files;
  }

  async download(
    ctx: PluginContext,
    fileId: string,
    revisionId?: string,
  ): Promise<ArrayBuffer> {
    const api = await this.createApi(ctx);
    const location = await this.resolveFileLocation(ctx, fileId);
    if (!location) throw new Error(`Cannot resolve location for file ${fileId}`);

    if (revisionId) {
      return api.client.getBinary(
        `${DEFAULT_BASE_URL}/2.0/projects/${enc(location.projectId)}/file_areas/${enc(location.fileAreaId)}/files/${enc(fileId)}/revisions/${enc(revisionId)}/content`,
      );
    }

    const metadataResponse = await api.client.get(
      `/5.0/projects/${enc(location.projectId)}/file_areas/${enc(location.fileAreaId)}/files/${enc(fileId)}`,
    );
    const metadata = convertToModel<DaluxFileResponse>(metadataResponse, FileResponseSchema, 'FileResponse');
    const downloadLink = metadata?.data.downloadLink ?? undefined;
    if (!downloadLink) {
      throw new Error(`Dalux file ${fileId} does not expose a download link`);
    }

    return api.client.getBinary(downloadLink);
  }

  async checkRevisions(
    ctx: PluginContext,
    fileIds: string[],
  ): Promise<RevisionEvent[]> {
    const events: RevisionEvent[] = [];

    for (const fileId of fileIds) {
      const cached = await ctx.storage.get(`rev:${fileId}`);
      const location = await this.resolveFileLocation(ctx, fileId);
      if (!location) continue;

      const files = await this.listFiles(
        ctx,
        location.folderId ?? location.fileAreaId,
      );
      const match = files.find((file) => file.id === fileId);
      if (!match?.currentRevisionId) continue;

      if (cached && cached !== match.currentRevisionId) {
        events.push({
          fileId,
          latestRevisionId: match.currentRevisionId,
          previousRevisionId: cached,
        });
      }

      await ctx.storage.set(`rev:${fileId}`, match.currentRevisionId);
    }

    return events;
  }

  async testConnection(ctx: PluginContext): Promise<ConnectionTestResult> {
    try {
      const projects = await this.listProjects(ctx);
      return {
        ok: true,
        message: `Connected — ${projects.length} project${projects.length === 1 ? '' : 's'} accessible.`,
        projectCount: projects.length,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('401') || message.includes('403')) {
        return {
          ok: false,
          message:
            'Your API identity lacks access. Check that the identity is assigned to a user group with project permissions.',
        };
      }
      return { ok: false, message };
    }
  }

  private async createApi(ctx: PluginContext): Promise<{
    client: BrowserDaluxApiClient;
    projects: ProjectsApi;
    fileAreas: FileAreasApi;
  }> {
    const apiKey = await ctx.getPreference('apiKey');
    if (!apiKey) throw new Error('Dalux API key not configured');

    const client = new BrowserDaluxApiClient({ baseUrl: DEFAULT_BASE_URL, apiKey }, ctx);

    return {
      client,
      projects: new ProjectsApi(client),
      fileAreas: new FileAreasApi(client),
    };
  }

  private async storeContainerLocation(
    ctx: PluginContext,
    containerId: string,
    location: ContainerLocation,
  ): Promise<void> {
    await ctx.storage.set(`container-loc:${containerId}`, JSON.stringify(location));
  }

  private async resolveContainerLocation(
    ctx: PluginContext,
    containerId: string,
  ): Promise<ContainerLocation | undefined> {
    const cached = await ctx.storage.get(`container-loc:${containerId}`);
    if (cached) {
      return JSON.parse(cached) as ContainerLocation;
    }

    const projects = await this.listProjects(ctx);
    for (const project of projects) {
      const containers = await this.listAllContainers(ctx, project.id);
      const match = containers.find((container) => container.id === containerId);
      if (!match) continue;

      const resolved = await ctx.storage.get(`container-loc:${containerId}`);
      if (resolved) {
        return JSON.parse(resolved) as ContainerLocation;
      }
    }

    return undefined;
  }

  private async resolveFileLocation(
    ctx: PluginContext,
    fileId: string,
  ): Promise<ContainerLocation | undefined> {
    const cached = await ctx.storage.get(`file-loc:${fileId}`);
    if (cached) {
      const parsed = JSON.parse(cached) as ContainerLocation;
      return parsed;
    }

    const projects = await this.listProjects(ctx);
    for (const project of projects) {
      const containers = await this.listAllContainers(ctx, project.id);
      for (const container of containers) {
        const files = await this.listFiles(ctx, container.id);
        const match = files.find((file) => file.id === fileId);
        if (!match) continue;

        const location = await this.resolveContainerLocation(ctx, container.id);
        if (!location) continue;

        await ctx.storage.set(`file-loc:${fileId}`, JSON.stringify(location));
        return location;
      }
    }

    return undefined;
  }
}

function toSourceFile(fileAreaId: string, file: DaluxFile): SourceFile {
  const currentRevisionId = file.fileRevisionId ?? file.fileId;
  const folderId = nonEmptyString(file.folderId);

  const revision: SourceRevision = {
    id: currentRevisionId,
    version: file.version ? Number(file.version) || 1 : 1,
    createdAt: file.lastModified ?? file.uploaded ?? new Date(0).toISOString(),
    createdBy: orUndefined(file.lastModifiedByUserId ?? file.uploadedByUserId),
    sizeBytes: orUndefined(file.fileSize),
  };

  return {
    id: file.fileId,
    name: file.fileName,
    // A file's real container is whichever folder it's actually filed under
    // — not the container the caller happened to query — falling back to
    // the file area root only when it has no folder at all.
    containerId: folderId ?? fileAreaId,
    mimeType: orUndefined(file.fileType),
    sizeBytes: orUndefined(file.fileSize),
    currentRevisionId,
    revisions: [revision],
    meta: {
      fileAreaId,
      folderId,
    },
  };
}

function enc(segment: string): string {
  return encodeURIComponent(segment);
}

function orUndefined<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined;
}

function nonEmptyString(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function matchGlob(pattern: string, name: string): boolean {
  const re = new RegExp(
    '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$',
    'i',
  );
  return re.test(name);
}

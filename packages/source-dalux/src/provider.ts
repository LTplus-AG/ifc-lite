/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/// <reference path="./dalux-build-api.d.ts" />

import { convertToModel } from 'dalux-build-api/src/models/convert.js';
import { FileSchema, FileResponseSchema } from 'dalux-build-api/src/models/files/index.js';
import { FolderSchema } from 'dalux-build-api/src/models/folders/index.js';
import { ProjectSchema } from 'dalux-build-api/src/models/projects/index.js';
import { FileAreaSchema } from 'dalux-build-api/src/models/fileAreas/index.js';

import type { DaluxFile, DaluxFileResponse } from 'dalux-build-api/src/models/files/index.js';
import type { DaluxFolder } from 'dalux-build-api/src/models/folders/index.js';
import type { DaluxProject } from 'dalux-build-api/src/models/projects/index.js';
import type { DaluxFileArea } from 'dalux-build-api/src/models/fileAreas/index.js';

import { matchesGlob } from '@ifc-lite/plugin-api';
import type {
  ConnectionTestResult,
  DownloadOptions,
  FileFilter,
  FileSourceProvider,
  ListOptions,
  ListProjectsOptions,
  Page,
  PluginContext,
  RevisionEvent,
  RevisionWatchResult,
  SourceContainer,
  SourceFile,
  SourceFileRef,
  SourceProject,
} from '@ifc-lite/plugin-api';

import { DALUX_MANIFEST } from './manifest.js';
import { BrowserDaluxApiClient, fetchPage, fetchAllPages } from './http-client.js';
import {
  LATEST_REVISION,
  convertListLenient,
  decodeContainerId,
  enc,
  fileAreaContainerId,
  folderContainerId,
  nonEmptyString,
  toSourceFile,
} from './mapping.js';

const DEFAULT_BASE_URL = 'https://node1.field.dalux.com/service/api';

export class DaluxBuildProvider implements FileSourceProvider {
  readonly manifest = DALUX_MANIFEST;

  async listProjects(ctx: PluginContext, options?: ListProjectsOptions): Promise<Page<SourceProject>> {
    const client = await this.createClient(ctx);
    const page = await fetchPage(client, '/5.1/projects', {}, options?.cursor, options?.signal);
    const projects = convertListLenient<DaluxProject>(ctx, page.items, ProjectSchema, 'Project');

    return {
      items: projects.map((project) => ({ id: project.projectId, name: project.projectName })),
      cursor: page.cursor,
    };
  }

  async listContainers(
    ctx: PluginContext,
    projectId: string,
    parentId?: string,
    options?: ListOptions,
  ): Promise<Page<SourceContainer>> {
    const client = await this.createClient(ctx);

    if (!parentId) {
      // Top level: just the file areas. Cheap — no folder walk, so the host
      // can show this list immediately instead of waiting on every file
      // area's (potentially deep) folder tree up front.
      const page = await fetchPage(
        client,
        `/5.1/projects/${enc(projectId)}/file_areas`,
        {},
        options?.cursor,
        options?.signal,
      );
      const fileAreas = convertListLenient<DaluxFileArea>(ctx, page.items, FileAreaSchema, 'FileArea');

      return {
        items: fileAreas.map((fileArea) => ({
          id: fileAreaContainerId(fileArea.fileAreaId),
          name: fileArea.fileAreaName,
          meta: { kind: 'file-area' },
        })),
        cursor: page.cursor,
      };
    }

    // `parentId` scopes to one file area (its container id carries no
    // folder component — see `decodeContainerId`). Dalux can't filter
    // folders by parent server-side, so every folder in the area comes back
    // regardless of nesting (capabilities.containerListing ===
    // 'flat-subtree'); the host nests the flattened result client-side via
    // each folder's `parentId`.
    const fileAreaId = decodeContainerId(parentId).fileAreaId;
    const page = await fetchPage(
      client,
      `/5.1/projects/${enc(projectId)}/file_areas/${enc(fileAreaId)}/folders`,
      {},
      options?.cursor,
      options?.signal,
    );
    const folders = convertListLenient<DaluxFolder>(ctx, page.items, FolderSchema, 'Folder');
    const folderIdsThisPage = new Set(folders.map((folder) => folder.folderId));

    const containers: SourceContainer[] = folders.map((folder) => {
      const parentFolderId = nonEmptyString(folder.parentFolderId);
      // A folder whose parent isn't the file area itself and isn't another
      // folder on this page is reattached to the file area root rather than
      // left dangling: Dalux sometimes reports folders whose parent is
      // never itself surfaced as a folder. Known limitation of paging one
      // Dalux bookmark page at a time (required so a large area doesn't
      // force one giant eager fetch): if a folder's true parent lands on a
      // *later* page, it's reattached to the root here too, and re-nests
      // correctly once the host has walked that later page and revisits it.
      const resolvedParentId =
        !parentFolderId || parentFolderId === fileAreaId || folderIdsThisPage.has(parentFolderId)
          ? (parentFolderId ?? fileAreaId)
          : fileAreaId;

      return {
        id: folderContainerId(fileAreaId, folder.folderId),
        name: folder.folderName,
        parentId:
          resolvedParentId === fileAreaId
            ? fileAreaContainerId(fileAreaId)
            : folderContainerId(fileAreaId, resolvedParentId),
        meta: { kind: 'folder', fileAreaId },
      };
    });

    return { items: containers, cursor: page.cursor };
  }

  async listFiles(
    ctx: PluginContext,
    projectId: string,
    containerId: string,
    filter?: FileFilter,
    options?: ListOptions,
  ): Promise<Page<SourceFile>> {
    const client = await this.createClient(ctx);
    const { fileAreaId, folderId } = decodeContainerId(containerId);

    const page = await fetchPage(
      client,
      `/6.1/projects/${enc(projectId)}/file_areas/${enc(fileAreaId)}/files`,
      folderId ? { folderId } : {},
      options?.cursor,
      options?.signal,
    );
    const daluxFiles = convertListLenient<DaluxFile>(ctx, page.items, FileSchema, 'File');
    const nonDeleted = daluxFiles.filter((file) => !file.deleted);

    let files = nonDeleted.map((file) => toSourceFile(fileAreaId, file));

    // The Dalux `files` endpoint doesn't reliably scope to the requested
    // folder — it can return every file in the file area regardless of the
    // `folderId` query param. Trust each file's own folder instead: a
    // folder-scoped query stays strict to that folder, while a file-area
    // query surfaces every descendant file (capabilities.listFilesIsRecursive).
    if (folderId) {
      files = files.filter((file) => file.containerId === containerId);
    }

    if (filter?.namePatterns?.length) {
      const patterns = filter.namePatterns;
      files = files.filter((file) => patterns.some((pattern) => matchesGlob(file.name, pattern)));
    }
    if (filter?.mimeTypes?.length) {
      const mimeTypes = filter.mimeTypes;
      files = files.filter((file) => file.mimeType && mimeTypes.includes(file.mimeType));
    }

    return { items: files, cursor: page.cursor };
  }

  async download(ctx: PluginContext, ref: SourceFileRef, options?: DownloadOptions): Promise<ArrayBuffer> {
    const client = await this.createClient(ctx);
    const { fileAreaId } = decodeContainerId(ref.containerId);
    // `LATEST_REVISION` is the sentinel `toSourceFile` reports when Dalux
    // gave no real `fileRevisionId`; treating it the same as "omitted" here
    // is what stops that case from ever reaching `/revisions/.../content`
    // with an id that isn't actually a revision id (see `mapping.ts`).
    const revisionId = ref.revisionId && ref.revisionId !== LATEST_REVISION ? ref.revisionId : undefined;

    if (revisionId) {
      return client.getBinary(
        `${DEFAULT_BASE_URL}/2.0/projects/${enc(ref.projectId)}/file_areas/${enc(fileAreaId)}` +
          `/files/${enc(ref.fileId)}/revisions/${enc(revisionId)}/content`,
        options?.signal,
      );
    }

    const metadataResponse = await client.get(
      `/5.0/projects/${enc(ref.projectId)}/file_areas/${enc(fileAreaId)}/files/${enc(ref.fileId)}`,
      {},
      options?.signal,
    );
    const metadata = convertToModel<DaluxFileResponse>(metadataResponse, FileResponseSchema, 'FileResponse');
    const downloadLink = metadata?.data.downloadLink ?? undefined;
    if (!downloadLink) {
      throw new Error(`Dalux file ${ref.fileId} does not expose a download link`);
    }

    return client.getBinary(downloadLink, options?.signal);
  }

  /**
   * Dalux has no delta/change-feed endpoint, so watching means polling the
   * given refs. Grouped strictly by file area so a sweep covering many refs
   * from the same area issues one listing sweep total — never a project- or
   * account-wide crawl, and never more than one sweep per distinct area.
   */
  async watchRevisions(
    ctx: PluginContext,
    refs: readonly SourceFileRef[],
    _cursor?: string,
    options?: ListOptions,
  ): Promise<RevisionWatchResult> {
    const client = await this.createClient(ctx);
    const events: RevisionEvent[] = [];

    const areas = new Map<string, { projectId: string; fileAreaId: string; refs: SourceFileRef[] }>();
    for (const ref of refs) {
      const { fileAreaId } = decodeContainerId(ref.containerId);
      const key = `${ref.projectId}::${fileAreaId}`;
      const area = areas.get(key);
      if (area) area.refs.push(ref);
      else areas.set(key, { projectId: ref.projectId, fileAreaId, refs: [ref] });
    }

    for (const { projectId, fileAreaId, refs: areaRefs } of areas.values()) {
      const rawItems = await fetchAllPages(
        client,
        `/6.1/projects/${enc(projectId)}/file_areas/${enc(fileAreaId)}/files`,
        {},
        options?.signal,
      );
      const daluxFiles = convertListLenient<DaluxFile>(ctx, rawItems, FileSchema, 'File');
      const filesById = new Map(
        daluxFiles.filter((file) => !file.deleted).map((file) => [file.fileId, file] as const),
      );

      for (const ref of areaRefs) {
        const cacheKey = `rev:${projectId}:${fileAreaId}:${ref.fileId}`;
        const match = filesById.get(ref.fileId);

        if (!match) {
          events.push({ fileId: ref.fileId, latestRevisionId: LATEST_REVISION, deleted: true });
          await ctx.storage.delete(cacheKey);
          continue;
        }

        const latestRevisionId = match.fileRevisionId ?? LATEST_REVISION;
        const cached = await ctx.storage.get(cacheKey);
        if (cached && cached !== latestRevisionId) {
          events.push({ fileId: ref.fileId, latestRevisionId, previousRevisionId: cached });
        }
        await ctx.storage.set(cacheKey, latestRevisionId);
      }
    }

    // No delta endpoint to resume from — every call is a fresh poll of the
    // given refs, so there is no cursor to hand back.
    return { events };
  }

  async testConnection(ctx: PluginContext): Promise<ConnectionTestResult> {
    try {
      const page = await this.listProjects(ctx);
      const count = page.items.length;
      const hasMore = Boolean(page.cursor);
      return {
        ok: true,
        message: hasMore
          ? `Connected — at least ${count} project${count === 1 ? '' : 's'} accessible (more available).`
          : `Connected — ${count} project${count === 1 ? '' : 's'} accessible.`,
        // Only report a count when it's the whole picture — a single page
        // isn't a cheap total when more pages remain.
        projectCount: hasMore ? undefined : count,
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

  private async createClient(ctx: PluginContext): Promise<BrowserDaluxApiClient> {
    const apiKey = await ctx.getPreference('apiKey');
    if (!apiKey) throw new Error('Dalux API key not configured');
    return new BrowserDaluxApiClient({ baseUrl: DEFAULT_BASE_URL, apiKey }, ctx);
  }
}

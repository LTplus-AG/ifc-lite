/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  decodeFile,
  decodeFileArea,
  decodeFileResponse,
  decodeFolder,
  decodeProject,
} from './dalux-types.js';

import type {
  DaluxFile,
  DaluxFileArea,
  DaluxFolder,
  DaluxProject,
} from './dalux-types.js';

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
import { BrowserDaluxApiClient, DaluxHttpError, fetchPage, fetchAllPages } from './http-client.js';
import {
  LATEST_REVISION,
  convertListLenient,
  currentRevisionId,
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
    const projects = convertListLenient<DaluxProject>(ctx, page.items, decodeProject, 'Project');

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
      const fileAreas = convertListLenient<DaluxFileArea>(ctx, page.items, decodeFileArea, 'FileArea');

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
    // Deliberately the one listing path that sweeps every page before
    // returning. Nesting is only decidable against the *complete* folder set:
    // a folder's parent can land on any page, and the host appends later
    // pages to what it already has (`useSourceCatalogSync` merges
    // `[...current.items, ...page.items]`) without ever re-resolving earlier
    // ones — so a parent id resolved against a single page is resolved
    // permanently, and wrongly. The sweep is bounded by `MAX_SWEEP_PAGES` and
    // covers folders only; files (the volume) stay paged one call at a time.
    const rawFolders = await fetchAllPages(
      client,
      `/5.1/projects/${enc(projectId)}/file_areas/${enc(fileAreaId)}/folders`,
      {},
      options?.signal,
    );
    const folders = convertListLenient<DaluxFolder>(ctx, rawFolders, decodeFolder, 'Folder');
    const folderIds = new Set(folders.map((folder) => folder.folderId));

    const containers: SourceContainer[] = folders.map((folder) => {
      const parentFolderId = nonEmptyString(folder.parentFolderId);
      // A folder whose parent is neither the file area itself nor any folder
      // in the area is reattached to the file area root rather than left
      // dangling: Dalux sometimes reports folders whose parent is never
      // itself surfaced as a folder, and a container pointing at a parent id
      // that never arrives is dropped from the host's tree entirely
      // (`buildContainerTree`). Because `folderIds` is built from the whole
      // area, "not in the area" now genuinely means unreachable rather than
      // merely "not on this page".
      const resolvedParentId =
        !parentFolderId || parentFolderId === fileAreaId || folderIds.has(parentFolderId)
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

    // The whole area is in `containers`, so there is no page left to hand
    // back — the host's "load more folders" affordance stays inert and the
    // catalog counts as completely fetched.
    return { items: containers, cursor: undefined };
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
    const daluxFiles = convertListLenient<DaluxFile>(ctx, page.items, decodeFile, 'File');
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
    // `LATEST_REVISION` is the sentinel `toSourceFile`/`currentRevisionId`
    // report when Dalux gave no real `fileRevisionId` or `contentHash`;
    // treating it the same as "omitted" here is what stops that case from
    // ever reaching `/revisions/.../content` with an id that isn't actually
    // a revision id (see `mapping.ts`). The sentinel is deliberately not
    // the plain string "latest" so this comparison isn't defeated by a file
    // that happens to carry a real revision id spelled that way (see the
    // collision note on `LATEST_REVISION` itself).
    const revisionId = ref.revisionId && ref.revisionId !== LATEST_REVISION ? ref.revisionId : undefined;

    if (revisionId) {
      // Built from the client's own base URL, not the module-level default
      // — the client is the single source of truth for which host this
      // request should go to, and diverging from it here would be a latent
      // bug the moment `baseUrl` ever becomes configurable.
      return client.getBinary(
        `${client.baseUrl}/2.0/projects/${enc(ref.projectId)}/file_areas/${enc(fileAreaId)}` +
          `/files/${enc(ref.fileId)}/revisions/${enc(revisionId)}/content`,
        options?.signal,
      );
    }

    const metadataResponse = await client.get(
      `/5.0/projects/${enc(ref.projectId)}/file_areas/${enc(fileAreaId)}/files/${enc(ref.fileId)}`,
      {},
      options?.signal,
    );
    const metadata = decodeFileResponse(metadataResponse);
    const downloadLink = metadata.data.downloadLink;
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
   *
   * Two failure-isolation rules, both load-bearing:
   *
   * 1. One area's sweep failing (a deleted file area 404ing, or a pagination
   *    error) must not abort the whole call — that would discard the
   *    already-detected events from every *other*, healthy area too. So each
   *    area's sweep is caught individually and warned about rather than the
   *    call rejecting outright. Only a definitive not-found (HTTP 404) turns
   *    into `deleted: true` events; any other failure leaves that area's refs
   *    without an event this poll, because "the request failed" is not
   *    evidence that "the file is gone upstream".
   * 2. `ctx.storage.set`/`delete` for every area are buffered and only
   *    committed once the whole sweep is done, never per-area as each area
   *    finishes. Advancing a cache immediately and *then* discovering a
   *    later area failed used to mean: if the host reacted to that failure
   *    by discarding this call's events, the already-advanced caches would
   *    make the next poll compare against the new value and never emit the
   *    now-lost event again — permanently. Buffering means a cache is only
   *    ever advanced past a change once that change's event has actually
   *    been returned.
   */
  async watchRevisions(
    ctx: PluginContext,
    refs: readonly SourceFileRef[],
    _cursor?: string,
    options?: ListOptions,
  ): Promise<RevisionWatchResult> {
    const client = await this.createClient(ctx);
    const events: RevisionEvent[] = [];
    const pendingSets = new Map<string, string>();
    const pendingDeletes = new Set<string>();

    const areas = new Map<string, { projectId: string; fileAreaId: string; refs: SourceFileRef[] }>();
    for (const ref of refs) {
      const { fileAreaId } = decodeContainerId(ref.containerId);
      const key = `${ref.projectId}::${fileAreaId}`;
      const area = areas.get(key);
      if (area) area.refs.push(ref);
      else areas.set(key, { projectId: ref.projectId, fileAreaId, refs: [ref] });
    }

    for (const { projectId, fileAreaId, refs: areaRefs } of areas.values()) {
      let filesById: Map<string, DaluxFile>;
      try {
        const rawItems = await fetchAllPages(
          client,
          `/6.1/projects/${enc(projectId)}/file_areas/${enc(fileAreaId)}/files`,
          {},
          options?.signal,
        );
        const daluxFiles = convertListLenient<DaluxFile>(ctx, rawItems, decodeFile, 'File');
        filesById = new Map(daluxFiles.filter((file) => !file.deleted).map((file) => [file.fileId, file] as const));
      } catch (err) {
        // This area's sweep failed outright. Never let the failure propagate
        // and take every other area's already-detected events down with it —
        // and never touch this area's caches below, so the next poll compares
        // against the same baseline instead of silently losing whatever
        // change caused the failure.
        //
        // `deleted: true` is contractually "the file is gone upstream", and
        // the host surfaces it to the user as exactly that. Only a definitive
        // not-found says that: a 500, a timeout, an aborted relay or a
        // pagination error say nothing at all about whether the files still
        // exist, so those refs are simply skipped this poll.
        const gone = err instanceof DaluxHttpError && err.status === 404;
        ctx.log.warn(
          gone
            ? 'Dalux: file area not found during watchRevisions, reporting its refs as deleted'
            : 'Dalux: file-area sweep failed during watchRevisions, skipping its refs this poll',
          {
            projectId,
            fileAreaId,
            error: err instanceof Error ? err.message : String(err),
          },
        );
        if (gone) {
          for (const ref of areaRefs) {
            events.push({ fileId: ref.fileId, latestRevisionId: LATEST_REVISION, deleted: true });
          }
        }
        continue;
      }

      for (const ref of areaRefs) {
        const cacheKey = `rev:${projectId}:${fileAreaId}:${ref.fileId}`;
        const match = filesById.get(ref.fileId);

        if (!match) {
          events.push({ fileId: ref.fileId, latestRevisionId: LATEST_REVISION, deleted: true });
          pendingDeletes.add(cacheKey);
          continue;
        }

        const latestRevisionId = currentRevisionId(match);
        // Before the first successful poll there is no cache entry. Falling
        // back to the ref's own `revisionId` — the revision the host is
        // currently holding for this file, produced by `currentRevisionId`
        // too, so directly comparable — is what stops a change made between
        // the file being tracked and the first poll from being swallowed
        // forever: with no baseline, that poll would emit nothing and then
        // cache the newer revision as if it had always been the known one.
        const baseline = (await ctx.storage.get(cacheKey)) ?? nonEmptyString(ref.revisionId);
        if (baseline && baseline !== latestRevisionId) {
          events.push({ fileId: ref.fileId, latestRevisionId, previousRevisionId: baseline });
        }
        pendingSets.set(cacheKey, latestRevisionId);
      }
    }

    // Commit only now that every area's sweep has run to completion (the
    // areas that threw above never reach here, so their caches are left
    // exactly as they were).
    for (const cacheKey of pendingDeletes) await ctx.storage.delete(cacheKey);
    for (const [cacheKey, revisionId] of pendingSets) await ctx.storage.set(cacheKey, revisionId);

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
      // Match on the actual HTTP status the client observed, not on
      // whether the (possibly truncated, upstream-authored) error message
      // happens to contain the digits "401"/"403" — a 500 whose body text
      // mentions either would otherwise be misreported as an auth failure.
      if (err instanceof DaluxHttpError && (err.status === 401 || err.status === 403)) {
        return {
          ok: false,
          message:
            'Your API identity lacks access. Check that the identity is assigned to a user group with project permissions.',
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message };
    }
  }

  private async createClient(ctx: PluginContext): Promise<BrowserDaluxApiClient> {
    const apiKey = await ctx.getPreference('apiKey');
    if (!apiKey) throw new Error('Dalux API key not configured');
    return new BrowserDaluxApiClient({ baseUrl: DEFAULT_BASE_URL, apiKey }, ctx);
  }
}

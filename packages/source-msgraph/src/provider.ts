/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type {
  ConnectionTestResult,
  DownloadOptions,
  FileFilter,
  FileSourceProvider,
  ListOptions,
  ListProjectsOptions,
  Page,
  PluginContext,
  RevisionWatchResult,
  SourceAuth,
  SourceContainer,
  SourceFile,
  SourceFileRef,
  SourceProject,
  SourceRevision,
} from '@ifc-lite/plugin-api';

import { MSGRAPH_MANIFEST } from './manifest.js';
import { MsGraphAuth, GraphAuthExpiredError } from './msal-client.js';
import { watchDriveRevisions } from './delta.js';
import { readResponseBody } from './download.js';
import {
  decodeContainerId,
  encodeContainerId,
  childrenEndpoint,
  onedriveProjectId,
  isOnedriveProject,
  projectSiteId,
  PROJECT_SITE_PREFIX,
} from './ids.js';
import {
  driveToContainer,
  driveItemToContainer,
  driveItemToFile,
  siteToProject,
  versionToRevision,
  matchesNameFilter,
  matchesSearchNameFilter,
  matchesMimeFilter,
} from './mapping.js';
import {
  graphGetJson,
  graphListAll,
  graphListPage,
  graphRequest,
  truncateErrorBody,
  type GraphTokenSource,
} from './graph-client.js';
import { isFile, isFolder } from './graph-types.js';
import type { GraphDrive, GraphDriveItem, GraphDriveItemVersion, GraphSite, GraphUser } from './graph-types.js';

export class MsGraphProvider implements FileSourceProvider {
  readonly manifest = MSGRAPH_MANIFEST;
  readonly auth: SourceAuth & GraphTokenSource;

  /** `auth` is overridable so tests can supply a fake bearer-token source with no real MSAL involved. */
  constructor(auth: SourceAuth & GraphTokenSource = new MsGraphAuth()) {
    this.auth = auth;
  }

  async listProjects(ctx: PluginContext, options?: ListProjectsOptions): Promise<Page<SourceProject>> {
    const query = options?.query?.trim();
    const cursor = options?.cursor;
    const projects: SourceProject[] = [];

    if (!query) {
      // No-query default: the user's own OneDrive plus whatever sites Graph
      // says they follow. `projectsAreDiscoverableOnly` tells the host this
      // is knowingly partial — delegated Graph has no "list every site".
      // "My OneDrive" only belongs on the first page: a `cursor` here is
      // always a `/me/followedSites` `@odata.nextLink`, and re-adding it on
      // every subsequent page would duplicate it in the host's listing.
      if (!cursor) {
        projects.push({ id: onedriveProjectId('me'), name: 'My OneDrive', meta: { kind: 'onedrive' } });
      }
      try {
        const page = await graphListPage<GraphSite>(
          ctx,
          this.auth,
          '/me/followedSites',
          cursor,
          options?.limit,
          options?.signal,
        );
        for (const site of page.items) projects.push(siteToProject(site, PROJECT_SITE_PREFIX));
        return { items: projects, cursor: page.cursor };
      } catch (err) {
        // /me/followedSites carries a documented known-issue about
        // occasionally-incorrect results; a hard failure on the *first* page
        // must not take down the OneDrive entry, which always works. Once
        // the host is mid-pagination (a cursor was supplied), though, a
        // failure here must surface rather than being reported as a clean
        // end-of-list — silently truncating would present a partial listing
        // as complete.
        if (cursor) throw err;
        ctx.log.warn('Failed to list followed SharePoint sites', { error: String(err) });
        return { items: projects };
      }
    }

    if (!cursor && ('onedrive'.includes(query.toLowerCase()) || 'my files'.includes(query.toLowerCase()))) {
      projects.push({ id: onedriveProjectId('me'), name: 'My OneDrive', meta: { kind: 'onedrive' } });
    }
    const page = await graphListPage<GraphSite>(
      ctx,
      this.auth,
      `/sites?search=${encodeURIComponent(query)}`,
      cursor,
      options?.limit,
      options?.signal,
    );
    for (const site of page.items) projects.push(siteToProject(site, PROJECT_SITE_PREFIX));
    return { items: projects, cursor: page.cursor };
  }

  async listContainers(
    ctx: PluginContext,
    projectId: string,
    parentId?: string,
    options?: ListOptions,
  ): Promise<Page<SourceContainer>> {
    if (!parentId) {
      if (isOnedriveProject(projectId)) return this.listOnedriveDrives(ctx, options);

      const siteId = projectSiteId(projectId);
      if (!siteId) throw new Error(`Unknown ms-graph project id: ${projectId}`);
      const page = await graphListPage<GraphDrive>(
        ctx,
        this.auth,
        `/sites/${encodeURIComponent(siteId)}/drives`,
        options?.cursor,
        options?.limit,
        options?.signal,
      );
      return { items: page.items.map(driveToContainer), cursor: page.cursor };
    }

    // Scoped to a drive or a folder within it: children come back mixed
    // (files and folders); listContainers reports only the folders, since
    // files are `listFiles`'s job.
    const { driveId } = decodeContainerId(parentId);
    const page = await graphListPage<GraphDriveItem>(
      ctx,
      this.auth,
      childrenEndpoint(parentId),
      options?.cursor,
      options?.limit,
      options?.signal,
    );
    const folders = page.items.filter(isFolder).map((item) => driveItemToContainer(driveId, parentId, item));
    return { items: folders, cursor: page.cursor };
  }

  async listFiles(
    ctx: PluginContext,
    _projectId: string,
    containerId: string,
    filter?: FileFilter,
    options?: ListOptions,
  ): Promise<Page<SourceFile>> {
    const page = await graphListPage<GraphDriveItem>(
      ctx,
      this.auth,
      childrenEndpoint(containerId),
      options?.cursor,
      options?.limit,
      options?.signal,
    );
    const files = page.items
      .filter(isFile)
      .map((item) => driveItemToFile(containerId, item))
      .filter((file) => matchesNameFilter(file.name, filter) && matchesMimeFilter(file.mimeType, filter));
    return { items: files, cursor: page.cursor };
  }

  async download(ctx: PluginContext, ref: SourceFileRef, options?: DownloadOptions): Promise<ArrayBuffer> {
    const { driveId } = decodeContainerId(ref.containerId);
    const itemBase = `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(ref.fileId)}`;

    const meta = await graphGetJson<GraphDriveItem>(
      ctx,
      this.auth,
      `${itemBase}?select=id,cTag,eTag,@microsoft.graph.downloadUrl`,
      { signal: options?.signal },
    );

    // `SourceFile.currentRevisionId` is the item's cTag (it changes with the
    // bytes and not with metadata), so a ref pinned to the revision the caller
    // last loaded is satisfied by the normal latest-content path as long as the
    // file has not moved on.
    const currentRevisionId = meta.cTag ?? meta.eTag ?? meta.id;
    if (ref.revisionId && ref.revisionId !== currentRevisionId) {
      // Historical versions are addressed by SharePoint version label via
      // `/versions/{id}/content`, which returns a 302 to a pre-authenticated
      // URL. A browser cannot follow that: the `Authorization` header forces a
      // CORS preflight, and a 302 is prohibited on a preflighted request — the
      // same constraint that rules out `/items/{id}/content`. Unlike that case
      // there is no `@microsoft.graph.downloadUrl` on a driveItemVersion to
      // fall back to, so this is not a limitation we can engineer around from
      // a static SPA. Fail with an explanation rather than a raw fetch error.
      throw new Error(
        `Cannot download version "${ref.revisionId}" of this file: Microsoft Graph serves ` +
          'historical versions only through a redirect that a browser cannot follow while ' +
          'authenticating. Only the current version can be downloaded client-side. ' +
          'Version history remains readable via listRevisions.',
      );
    }

    const downloadUrl = meta['@microsoft.graph.downloadUrl'];
    if (!downloadUrl) {
      throw new Error(`Graph item ${ref.fileId} did not return a pre-authenticated download URL.`);
    }

    // `ctx.fetchPublic`, never `ctx.fetch`: this URL is pre-authenticated and
    // Microsoft's own docs say an Authorization header on it gets rejected.
    // It's also the only path allowed to reach the tenant-specific
    // *.sharepoint.com / *.1drv.com host it points at
    // (`permissions.publicNetwork`, not `permissions.network`).
    const response = await ctx.fetchPublic(downloadUrl, { signal: options?.signal });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      // The full body is worth keeping for diagnostics; the message below
      // reaches user-facing toasts, so it must stay short.
      if (body) ctx.log.error(`Pre-authenticated download failed (${response.status} ${response.statusText})`, { body });
      throw new Error(
        `Download failed (${response.status} ${response.statusText})${body ? `: ${truncateErrorBody(body)}` : ''}. ` +
          'The pre-authenticated download URL may have expired (it lives roughly an hour, ' +
          'sometimes only minutes) — retry the download to fetch a fresh one.',
      );
    }
    return readResponseBody(response, options?.onProgress);
  }

  async listRevisions(
    ctx: PluginContext,
    ref: SourceFileRef,
    options?: ListOptions,
  ): Promise<Page<SourceRevision>> {
    const { driveId } = decodeContainerId(ref.containerId);
    const page = await graphListPage<GraphDriveItemVersion>(
      ctx,
      this.auth,
      `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(ref.fileId)}/versions`,
      options?.cursor,
      options?.limit,
      options?.signal,
    );
    return { items: page.items.map(versionToRevision), cursor: page.cursor };
  }

  async watchRevisions(
    ctx: PluginContext,
    refs: readonly SourceFileRef[],
    cursor?: string,
    options?: ListOptions,
  ): Promise<RevisionWatchResult> {
    return watchDriveRevisions(ctx, this.auth, refs, cursor, options?.signal);
  }

  async searchFiles(
    ctx: PluginContext,
    projectId: string,
    query: string,
    filter?: FileFilter,
    options?: ListOptions,
  ): Promise<Page<SourceFile>> {
    const driveIds = await this.listDriveIdsForProject(ctx, projectId, options?.signal);
    const escaped = query.replace(/'/g, "''");
    const results: SourceFile[] = [];

    for (const driveId of driveIds) {
      // Graph's search matches file *content* too (STEP text can contain
      // "ifc" regardless of extension), and the index lags children
      // listings by minutes — both are why `matchesSearchNameFilter` always
      // applies a name check, never trusting the hit list alone.
      const items = await graphListAll<GraphDriveItem>(
        ctx,
        this.auth,
        `/drives/${encodeURIComponent(driveId)}/root/search(q='${encodeURIComponent(escaped)}')`,
        options?.signal,
      );
      for (const item of items) {
        if (!isFile(item)) continue;
        const name = item.name ?? '';
        if (!matchesSearchNameFilter(name, filter)) continue;
        if (!matchesMimeFilter(item.file?.mimeType, filter)) continue;
        const parentDriveId = item.parentReference?.driveId ?? driveId;
        const containerId = encodeContainerId(parentDriveId, item.parentReference?.id);
        results.push(driveItemToFile(containerId, item));
      }
    }

    return { items: results };
  }

  async testConnection(ctx: PluginContext): Promise<ConnectionTestResult> {
    try {
      const user = await graphGetJson<GraphUser>(ctx, this.auth, '/me');
      const projects = await this.listProjects(ctx);
      const label = user.displayName ?? user.userPrincipalName ?? user.id;
      return {
        ok: true,
        message:
          `Connected as ${label} — ${projects.items.length} location${projects.items.length === 1 ? '' : 's'} ` +
          'found (SharePoint sites are search-only, so more may exist than are listed here).',
        projectCount: projects.items.length,
      };
    } catch (err) {
      if (err instanceof GraphAuthExpiredError) return { ok: false, message: err.message };
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private async listOnedriveDrives(ctx: PluginContext, options?: ListOptions): Promise<Page<SourceContainer>> {
    try {
      const page = await graphListPage<GraphDrive>(
        ctx,
        this.auth,
        '/me/drives',
        options?.cursor,
        options?.limit,
        options?.signal,
      );
      if (page.items.length > 0) return { items: page.items.map(driveToContainer), cursor: page.cursor };
    } catch (err) {
      ctx.log.warn('/me/drives failed, falling back to /me/drive', { error: String(err) });
    }
    // Consumer Microsoft accounts, and some tenant configurations, only
    // support the singular endpoint.
    const drive = await graphGetJson<GraphDrive>(ctx, this.auth, '/me/drive', { signal: options?.signal });
    return { items: [driveToContainer(drive)] };
  }

  private async listDriveIdsForProject(
    ctx: PluginContext,
    projectId: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    if (isOnedriveProject(projectId)) {
      const page = await this.listOnedriveDrives(ctx, { signal });
      return page.items.map((container) => container.id);
    }
    const siteId = projectSiteId(projectId);
    if (!siteId) throw new Error(`Unknown ms-graph project id: ${projectId}`);
    const drives = await graphListAll<GraphDrive>(ctx, this.auth, `/sites/${encodeURIComponent(siteId)}/drives`, signal);
    return drives.map((drive) => drive.id);
  }
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

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
  SourceRevision,
} from '@ifc-lite/plugin-api';

import { msGraphAuth, createTokenManager, getTenant, requireClientId } from './auth.js';
import { BrowserGraphApiClient, GraphHttpError, fetchPage } from './http-client.js';
import { decodeDrive, decodeDriveItem } from './msgraph-types.js';
import {
  childrenEndpoint,
  clampPageSize,
  currentRevisionId,
  decodeDriveItems,
  decodeDriveItemVersions,
  enc,
  searchEndpoint,
  toSourceContainer,
  toSourceFile,
  toSourceRevision,
} from './mapping.js';
import { MSGRAPH_MANIFEST } from './manifest.js';

/** The single project this provider exposes. Delegated `Files.Read` grants
 *  no "list every site/drive I can see" endpoint (Sites.Read.All would, but
 *  that's a higher-privileged, admin-consentable scope this provider
 *  deliberately doesn't request — see the manifest and README) — only the
 *  signed-in user's own default drive is structurally enumerable without it.
 *  A fixed, single project id keeps that honest instead of inventing project
 *  discovery this scope can't actually back. */
const ME_PROJECT_ID = 'me';

export class MsGraphProvider implements FileSourceProvider {
  readonly manifest = MSGRAPH_MANIFEST;
  readonly auth = msGraphAuth;

  async listProjects(ctx: PluginContext, _options?: ListProjectsOptions): Promise<Page<SourceProject>> {
    const client = await this.createClient(ctx);
    const raw = await client.get('/me/drive', { $select: 'id,name,driveType,owner' });
    const drive = decodeDrive(raw);

    return {
      items: [
        {
          id: ME_PROJECT_ID,
          name: drive.name && drive.name.length > 0 ? drive.name : 'OneDrive',
          meta: { driveId: drive.id, driveType: drive.driveType, owner: drive.owner?.user?.displayName },
        },
      ],
      // Exactly one project is ever known — see `ME_PROJECT_ID`'s doc comment.
      cursor: undefined,
    };
  }

  async listContainers(
    ctx: PluginContext,
    _projectId: string,
    parentId?: string,
    options?: ListOptions,
  ): Promise<Page<SourceContainer>> {
    const client = await this.createClient(ctx);
    const endpoint = options?.cursor ?? childrenEndpoint(parentId);
    const params: Record<string, string> = options?.cursor ? {} : { $top: clampPageSize(options?.limit) };
    const page = await fetchPage(client, endpoint, params, options?.signal);
    const items = decodeDriveItems(ctx, page.items);

    const containers = items
      .filter((item) => item.folder !== undefined)
      .map((item) => toSourceContainer(item, parentId));

    return { items: containers, cursor: page.cursor };
  }

  async listFiles(
    ctx: PluginContext,
    _projectId: string,
    containerId: string,
    filter?: FileFilter,
    options?: ListOptions,
  ): Promise<Page<SourceFile>> {
    const client = await this.createClient(ctx);
    const endpoint = options?.cursor ?? childrenEndpoint(containerId);
    const params: Record<string, string> = options?.cursor ? {} : { $top: clampPageSize(options?.limit) };
    const page = await fetchPage(client, endpoint, params, options?.signal);
    const items = decodeDriveItems(ctx, page.items);

    let files = items.filter((item) => item.file !== undefined).map((item) => toSourceFile(item, containerId));
    files = applyFileFilter(files, filter);

    return { items: files, cursor: page.cursor };
  }

  async searchFiles(
    ctx: PluginContext,
    _projectId: string,
    query: string,
    filter?: FileFilter,
    options?: ListOptions,
  ): Promise<Page<SourceFile>> {
    const client = await this.createClient(ctx);
    const endpoint = options?.cursor ?? searchEndpoint(query);
    const params: Record<string, string> = options?.cursor ? {} : { $top: clampPageSize(options?.limit) };
    const page = await fetchPage(client, endpoint, params, options?.signal);
    const items = decodeDriveItems(ctx, page.items);

    // Search results carry `parentReference.id` rather than the queried
    // containerId (a search can span the whole drive) — each file's real
    // parent, same "not necessarily the one queried" rule `SourceFile.containerId`
    // documents.
    let files = items
      .filter((item) => item.file !== undefined)
      .map((item) => toSourceFile(item, item.parentReference?.id ?? containerFallback(item)));
    files = applyFileFilter(files, filter);

    return { items: files, cursor: page.cursor };
  }

  /**
   * Downloads a file's bytes. Fetches the item's pre-signed
   * `@microsoft.graph.downloadUrl` and retrieves *that* URL — never
   * `GET .../content` directly.
   *
   * Per Microsoft Graph's own docs ("Download driveItem content",
   * `learn.microsoft.com/graph/api/driveitem-get-content`, section
   * "Downloading files in JavaScript apps", checked 2026-08-15): `/content`
   * returns a `302 Found` redirect to the same pre-signed URL, and "you can't
   * use the `/content` API [in a JavaScript app], because this responds with
   * a `302` redirect. A `302` redirect is explicitly prohibited when a
   * [CORS] preflight is required, such as when providing the Authorization
   * header." The docs' own fix is exactly this: "select the
   * `@microsoft.graph.downloadUrl` property... requested directly using
   * XMLHttpRequest. Because these URLs are preauthenticated, they can be
   * retrieved without a CORS preflight" — i.e. with no `Authorization` header
   * at all, which is why this goes through `ctx.fetchPublic` (strips every
   * header except `Accept`/`Range`) rather than `ctx.fetch`.
   */
  async download(ctx: PluginContext, ref: SourceFileRef, options?: DownloadOptions): Promise<ArrayBuffer> {
    const client = await this.createClient(ctx);
    const raw = await client.get(
      `/me/drive/items/${enc(ref.fileId)}`,
      { $select: 'id,name,cTag,eTag,@microsoft.graph.downloadUrl' },
      options?.signal,
    );
    const item = decodeDriveItem(raw);

    if (ref.revisionId && ref.revisionId !== currentRevisionId(item)) {
      // `capabilities.downloadHistoricalRevisions` is `false` — the host must
      // never ask for a `revisionId` other than current (see the doc comment
      // on that flag in `@ifc-lite/plugin-api`), but this stays a loud error
      // rather than silently serving the wrong (current) bytes for whatever
      // older revision was actually requested.
      //
      // Note this compares against the cTag, while `listRevisions` reports
      // SharePoint version labels — so even the newest *listed* revision is
      // rejected here. Why that is correct rather than a gap is written out on
      // `toSourceRevision` in `mapping.ts`.
      throw new Error(
        `Microsoft Graph provider cannot download historical revision "${ref.revisionId}" of ${ref.fileId} — ` +
          'only the current revision is retrievable (Graph exposes no CORS-safe download URL for old versions).',
      );
    }

    const downloadUrl = item['@microsoft.graph.downloadUrl'];
    if (!downloadUrl) {
      throw new Error(`Microsoft Graph item ${ref.fileId} does not expose a download URL`);
    }

    return client.getPublicBinary(downloadUrl, options?.signal);
  }

  async listRevisions(ctx: PluginContext, ref: SourceFileRef, options?: ListOptions): Promise<Page<SourceRevision>> {
    const client = await this.createClient(ctx);
    const endpoint = options?.cursor ?? `/me/drive/items/${enc(ref.fileId)}/versions`;
    const page = await fetchPage(client, endpoint, {}, options?.signal);
    const versions = decodeDriveItemVersions(ctx, page.items);

    return { items: versions.map(toSourceRevision), cursor: page.cursor };
  }

  /**
   * Watches for changes via Graph's `/delta` change feed
   * (`GET /me/drive/root/delta`) rather than polling the given `refs` — per
   * the contract, "Providers with a delta or change-feed endpoint should use
   * `cursor` and ignore `refs`, returning a fresh cursor each call."
   *
   * `refs` is still consulted, but only to decide which delta items are
   * worth turning into an event: the feed reports every change across the
   * whole drive, and a host tracking a handful of files should not be told
   * about unrelated ones.
   */
  async watchRevisions(
    ctx: PluginContext,
    refs: readonly SourceFileRef[],
    cursor?: string,
    options?: ListOptions,
  ): Promise<RevisionWatchResult> {
    const client = await this.createClient(ctx);
    const endpoint = cursor ?? '/me/drive/root/delta';
    const page = await fetchPage(client, endpoint, {}, options?.signal);
    const items = decodeDriveItems(ctx, page.items);

    const trackedById = new Map(refs.map((ref) => [ref.fileId, ref] as const));
    const events: RevisionEvent[] = [];

    for (const item of items) {
      const ref = trackedById.get(item.id);
      if (!ref) continue;

      if (item.deleted) {
        events.push({ fileId: item.id, latestRevisionId: currentRevisionId(item), deleted: true });
        continue;
      }

      const latestRevisionId = currentRevisionId(item);
      if (!ref.revisionId || ref.revisionId !== latestRevisionId) {
        events.push({ fileId: item.id, latestRevisionId, previousRevisionId: ref.revisionId });
      }
    }

    // `@odata.nextLink` (more pages in this same sync pass) takes priority
    // over `@odata.deltaLink` (this sync pass is caught up) as the handed-back
    // cursor — both are valid opaque resume tokens for the next
    // `watchRevisions` call, but only `nextLink` means "there is more to read
    // right now."
    return { events, cursor: page.cursor ?? page.deltaLink };
  }

  async testConnection(ctx: PluginContext): Promise<ConnectionTestResult> {
    try {
      const client = await this.createClient(ctx);
      await client.get('/me/drive', { $select: 'id' });
      return { ok: true, message: 'Connected to Microsoft Graph.', projectCount: 1 };
    } catch (err) {
      if (err instanceof GraphHttpError && (err.status === 401 || err.status === 403)) {
        return {
          ok: false,
          message: 'Sign-in expired or the account lacks access. Try signing in again.',
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message };
    }
  }

  private async createClient(ctx: PluginContext): Promise<BrowserGraphApiClient> {
    const clientId = await requireClientId(ctx);
    const tenant = await getTenant(ctx);
    const manager = createTokenManager(ctx, clientId, tenant);
    const accessToken = await manager.getValidAccessToken();
    return new BrowserGraphApiClient(accessToken, ctx);
  }
}

function applyFileFilter(files: SourceFile[], filter?: FileFilter): SourceFile[] {
  let result = files;
  if (filter?.namePatterns?.length) {
    const patterns = filter.namePatterns;
    result = result.filter((file) => patterns.some((pattern) => matchesGlob(file.name, pattern)));
  }
  if (filter?.mimeTypes?.length) {
    const mimeTypes = filter.mimeTypes;
    result = result.filter((file) => file.mimeType && mimeTypes.includes(file.mimeType));
  }
  return result;
}

/** Search results with no `parentReference` (shouldn't happen for a real
 *  driveItem, but decoders never assume upstream always sends every optional
 *  field) fall back to the drive root rather than an empty string, which
 *  would otherwise become an unaddressable `containerId` no `listFiles` call
 *  could ever repeat. */
function containerFallback(_item: { readonly id: string }): string {
  return 'root';
}

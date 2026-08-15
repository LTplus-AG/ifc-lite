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

import { createTokenManager, dropboxAuth, requireClientId } from './auth.js';
import { BrowserDropboxApiClient, DropboxHttpError } from './http-client.js';
import { decodeCurrentAccount, decodeListFolderResult, decodeListRevisionsResult, decodeSearchResult } from './dropbox-types.js';
import {
  clampPageSize,
  clampRevisionsPageSize,
  decodeFileRevisions,
  decodeMetadataEntries,
  pathArgFor,
  searchResultContainerId,
  toSourceContainer,
  toSourceFile,
  toSourceRevision,
} from './mapping.js';
import { DROPBOX_MANIFEST } from './manifest.js';

/** The single project this provider exposes. Dropbox's consumer API has no
 *  "list every team/shared space I can see" for a personal account scope —
 *  only the signed-in user's own Dropbox is structurally enumerable with the
 *  scopes this provider requests (see the manifest and README). A fixed,
 *  single project id keeps that honest instead of inventing project
 *  discovery this scope can't actually back, mirroring `source-msgraph`'s
 *  `ME_PROJECT_ID`. */
const MY_DROPBOX_PROJECT_ID = 'me';

export class DropboxProvider implements FileSourceProvider {
  readonly manifest = DROPBOX_MANIFEST;
  readonly auth = dropboxAuth;

  async listProjects(ctx: PluginContext, _options?: ListProjectsOptions): Promise<Page<SourceProject>> {
    const client = await this.createClient(ctx);
    const raw = await client.rpc('/users/get_current_account', null);
    const account = decodeCurrentAccount(raw);

    return {
      items: [
        {
          id: MY_DROPBOX_PROJECT_ID,
          name: account.displayName ? `${account.displayName}'s Dropbox` : 'My Dropbox',
          meta: { accountId: account.account_id },
        },
      ],
      // Exactly one project is ever known — see `MY_DROPBOX_PROJECT_ID`'s doc comment.
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
    const page = await this.listFolderPage(client, parentId, options);
    const entries = decodeMetadataEntries(ctx, page.entries);

    const containers = entries
      .filter((entry) => entry['.tag'] === 'folder')
      .map((entry) => toSourceContainer(entry, parentId));

    return { items: containers, cursor: page.has_more ? page.cursor : undefined };
  }

  async listFiles(
    ctx: PluginContext,
    _projectId: string,
    containerId: string,
    filter?: FileFilter,
    options?: ListOptions,
  ): Promise<Page<SourceFile>> {
    const client = await this.createClient(ctx);
    const page = await this.listFolderPage(client, containerId, options);
    const entries = decodeMetadataEntries(ctx, page.entries);

    let files = entries.filter((entry) => entry['.tag'] === 'file').map((entry) => toSourceFile(entry, containerId));
    files = applyFileFilter(files, filter);

    return { items: files, cursor: page.has_more ? page.cursor : undefined };
  }

  async searchFiles(
    ctx: PluginContext,
    _projectId: string,
    query: string,
    filter?: FileFilter,
    options?: ListOptions,
  ): Promise<Page<SourceFile>> {
    const client = await this.createClient(ctx);

    const raw = options?.cursor
      ? await client.rpc('/files/search/continue_v2', { cursor: options.cursor }, options.signal)
      : await client.rpc(
          '/files/search_v2',
          {
            query,
            options: {
              path: '',
              filename_only: false,
              max_results: clampPageSize(options?.limit),
            },
          },
          options?.signal,
        );

    const result = decodeSearchResult(raw);

    let files = result.matches
      .filter((match) => match.metadata['.tag'] === 'file')
      .map((match) =>
        toSourceFile(match.metadata as Extract<typeof match.metadata, { readonly ['.tag']: 'file' }>, searchResultContainerId(match.metadata.path_lower)),
      );
    files = applyFileFilter(files, filter);

    return { items: files, cursor: result.has_more ? result.cursor : undefined };
  }

  /**
   * Downloads a file's bytes via `files/download` on `content.dropboxapi.com`
   * — a direct, authenticated, non-redirecting POST (see the citation on
   * `downloadContent()` in `http-client.ts`), never a pre-signed URL the way
   * Microsoft Graph requires.
   *
   * A `revisionId` is honored directly: Dropbox's `path` argument accepts
   * the form `"rev:<rev-id>"` to address a specific historical revision
   * (the separate, older `rev` request parameter on this endpoint is
   * deprecated in favor of embedding it in `path` — Dropbox Community
   * guidance and `dropbox/revision-browser`'s reference implementation,
   * checked 2026-08-15). A `rev` string is globally unique to one file's one
   * revision, so this needs no separate metadata lookup the way
   * `source-msgraph`'s `download()` does to validate `ref.revisionId`
   * against the item's current one — an invalid or mismatched rev is
   * rejected by Dropbox itself (surfaced here as a `DropboxHttpError`)
   * rather than silently serving the wrong bytes.
   */
  async download(ctx: PluginContext, ref: SourceFileRef, options?: DownloadOptions): Promise<ArrayBuffer> {
    const client = await this.createClient(ctx);
    const path = ref.revisionId ? `rev:${ref.revisionId}` : pathArgFor(ref.fileId);
    return client.downloadContent(path, options?.signal);
  }

  /**
   * `files/list_revisions` **does** paginate, just not via an opaque cursor
   * token the way `files/list_folder`/`search_v2` do: Dropbox's
   * `ListRevisionsResult.has_more` and `ListRevisionsArg.before_rev` (its
   * `files.stone` API spec) form a real continuation mechanism — "Call
   * list_revisions again with before_rev equal to the revision of the last
   * returned entry to retrieve the rest." Revisions come back newest-first
   * (see `provider.test.ts`), so the last entry of a page is its oldest, and
   * `before_rev` set to that `rev` asks for the next-older page. This
   * provider surfaces that as `Page.cursor` like every other paged method
   * here: the opaque value it hands back is simply the last entry's `rev`,
   * and `options?.cursor` is forwarded straight through as `before_rev`
   * (`before_rev` is only honored in `mode: 'path'`, which this call already
   * uses). `limit` is capped at 100, not `files/list_folder`'s 2000 — see
   * `clampRevisionsPageSize`.
   */
  async listRevisions(ctx: PluginContext, ref: SourceFileRef, options?: ListOptions): Promise<Page<SourceRevision>> {
    const client = await this.createClient(ctx);
    const raw = await client.rpc(
      '/files/list_revisions',
      {
        path: pathArgFor(ref.fileId),
        mode: 'path',
        limit: clampRevisionsPageSize(options?.limit),
        ...(options?.cursor ? { before_rev: options.cursor } : {}),
      },
      options?.signal,
    );
    const result = decodeListRevisionsResult(raw);
    const revisions = decodeFileRevisions(ctx, result.entries);
    const oldestOfPage = revisions[revisions.length - 1];

    return {
      items: revisions.map(toSourceRevision),
      cursor: result.has_more && oldestOfPage ? oldestOfPage.rev : undefined,
    };
  }

  /**
   * Watches for changes via `files/list_folder/continue`'s cursor, Dropbox's
   * change-feed equivalent of Graph's `/delta` (per the manifest's
   * `changeDetection` doc comment) rather than polling the given `refs`.
   *
   * With no `cursor` yet, this establishes one via
   * `files/list_folder/get_latest_cursor` (`recursive: true` at the account
   * root) — a dedicated endpoint that returns *only* a cursor, with no
   * entries fetched, so establishing a baseline doesn't cost sweeping the
   * whole account. That first call reports no events (nothing has "changed"
   * relative to a baseline just established); only subsequent calls, passing
   * that cursor back in, report real deltas.
   *
   * **Documented limitation**: Dropbox's `DeletedMetadata` (what a deleted
   * entry decodes to — see `dropbox-types.ts`) carries no `id` field, only
   * `name`/`path_lower`. This provider addresses every tracked
   * `SourceFileRef` by opaque `id` (see `pathArgFor`'s doc comment), so a
   * deletion reported by the cursor feed cannot be matched back to a tracked
   * ref by id — deleted entries are therefore silently skipped rather than
   * guessed-matched by name/path, which could misfire on a same-named file
   * elsewhere. Updates and new content are unaffected: `FileMetadata`
   * entries always carry `id`. A host relying on this provider for deletion
   * detection specifically should not assume it fires.
   */
  async watchRevisions(
    ctx: PluginContext,
    refs: readonly SourceFileRef[],
    cursor?: string,
    options?: ListOptions,
  ): Promise<RevisionWatchResult> {
    const client = await this.createClient(ctx);

    if (!cursor) {
      const raw = await client.rpc('/files/list_folder/get_latest_cursor', { path: '', recursive: true }, options?.signal);
      const baseline = decodeCursorOnly(raw);
      return { events: [], cursor: baseline };
    }

    const raw = await client.rpc('/files/list_folder/continue', { cursor }, options?.signal);
    const page = decodeListFolderResult(raw);
    const entries = decodeMetadataEntries(ctx, page.entries);

    const trackedById = new Map(refs.map((ref) => [ref.fileId, ref] as const));
    const events: RevisionEvent[] = [];

    for (const entry of entries) {
      if (entry['.tag'] !== 'file') continue; // folders carry no revisionId; deleted entries carry no id (see doc comment above)
      const ref = trackedById.get(entry.id);
      if (!ref) continue;

      const latestRevisionId = entry.rev;
      if (!ref.revisionId || ref.revisionId !== latestRevisionId) {
        events.push({ fileId: entry.id, latestRevisionId, previousRevisionId: ref.revisionId });
      }
    }

    return { events, cursor: page.cursor };
  }

  async testConnection(ctx: PluginContext): Promise<ConnectionTestResult> {
    try {
      const client = await this.createClient(ctx);
      await client.rpc('/users/get_current_account', null);
      return { ok: true, message: 'Connected to Dropbox.', projectCount: 1 };
    } catch (err) {
      if (err instanceof DropboxHttpError && (err.status === 401 || err.status === 403)) {
        return {
          ok: false,
          message: 'Sign-in expired or the account lacks access. Try signing in again.',
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message };
    }
  }

  private async listFolderPage(
    client: BrowserDropboxApiClient,
    containerId: string | undefined,
    options?: ListOptions,
  ) {
    const raw = options?.cursor
      ? await client.rpc('/files/list_folder/continue', { cursor: options.cursor }, options.signal)
      : await client.rpc(
          '/files/list_folder',
          { path: pathArgFor(containerId), recursive: false, limit: clampPageSize(options?.limit) },
          options?.signal,
        );
    return decodeListFolderResult(raw);
  }

  private async createClient(ctx: PluginContext): Promise<BrowserDropboxApiClient> {
    const clientId = await requireClientId(ctx);
    const manager = createTokenManager(ctx, clientId);
    const accessToken = await manager.getValidAccessToken();
    return new BrowserDropboxApiClient(accessToken, ctx);
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

/** `files/list_folder/get_latest_cursor` responds with just `{ cursor }` —
 *  no `entries`/`has_more` the way a full listing page has. */
function decodeCursorOnly(raw: unknown): string {
  if (typeof raw !== 'object' || raw === null || typeof (raw as { cursor?: unknown }).cursor !== 'string') {
    throw new Error('Dropbox list_folder/get_latest_cursor response is missing "cursor"');
  }
  return (raw as { cursor: string }).cursor;
}

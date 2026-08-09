/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * An in-memory stand-in for the Dalux Build REST API, wired in as a
 * `PluginContext.fetch`.
 *
 * Unlike the per-assertion `vi.fn()` mocks in `provider.test.ts`, this one
 * serves a whole consistent world across every endpoint the provider
 * touches, so `DaluxBuildProvider` can be driven end-to-end — which is what
 * the conformance suite needs: it browses, pages, cross-checks containers
 * against files and downloads bytes, all against the same tenant.
 *
 * Two things it deliberately reproduces rather than idealises:
 *
 * 1. **Bookmark pagination with a server-chosen page size.** Dalux pages by
 *    minting an opaque `bookmark` on a `nextPage` link; the caller has no
 *    say in how big a page is. `ListOptions.limit` is documented as a hint
 *    and `DaluxBuildProvider` never forwards it, so this mock ignores it
 *    too — a mock that honoured `limit` would let the provider pass paging
 *    checks it cannot actually pass in production.
 * 2. **`metadata.totalRemainingItems` in the shapes seen live.** See
 *    {@link DaluxRemainingSemantics}: the field's meaning is not fixed
 *    across Dalux endpoints, and misreading it is what #2252 turned on.
 */

import type { KeyValueStore, Logger, PluginContext } from '@ifc-lite/plugin-api';

export const DALUX_MOCK_BASE_URL = 'https://node1.field.dalux.com/service/api';

export interface DaluxMockFolder {
  readonly folderId: string;
  readonly folderName: string;
  readonly parentFolderId?: string;
}

export interface DaluxMockFile {
  readonly fileId: string;
  readonly fileName: string;
  /** Omitted for a file sitting directly in the file area root. */
  readonly folderId?: string;
  readonly fileRevisionId?: string;
  readonly contentHash?: string;
  readonly fileType?: string;
  readonly deleted?: boolean;
  /** Body served by both the download-link and the by-revision content route. */
  readonly content: string;
}

export interface DaluxMockFileArea {
  readonly fileAreaId: string;
  readonly fileAreaName: string;
  readonly fileAreaType: string;
  readonly folders: readonly DaluxMockFolder[];
  readonly files: readonly DaluxMockFile[];
}

export interface DaluxMockProject {
  readonly projectId: string;
  readonly projectName: string;
  readonly fileAreas: readonly DaluxMockFileArea[];
}

export interface DaluxMockWorld {
  readonly projects: readonly DaluxMockProject[];
}

/**
 * Which of the two observed readings of `metadata.totalRemainingItems` the
 * mock serves.
 *
 * - `'total'` — the field echoes the *total* item count on Dalux's side, so
 *   a complete single-page listing reports `remaining === items.length` with
 *   no `nextPage` link. This is what `GET /5.1/projects` was observed doing
 *   live (#2252): 63 projects, one page, no link, `totalRemainingItems: 63`.
 * - `'after-page'` — the field counts items left *after* this page, so the
 *   last page reports `0`. The reading the name suggests.
 * - `'omitted'` — no `metadata` block at all, which Dalux also does.
 *
 * A conformant reader must land on the same answer for all three: the
 * `nextPage` link is the only authority on whether more pages exist.
 */
export type DaluxRemainingSemantics = 'total' | 'after-page' | 'omitted';

export interface DaluxMockOptions {
  /**
   * Items per response, the server's own choice. Default `1` so every
   * multi-item listing genuinely crosses a page boundary; raise it above a
   * listing's size to model the single-page tenant Dalux returns for small
   * accounts.
   */
  readonly pageSize?: number;
  /** Default `'total'` — the shape actually seen live. */
  readonly remainingSemantics?: DaluxRemainingSemantics;
}

interface MockResponseInit {
  readonly status?: number;
  readonly json?: unknown;
  readonly body?: string;
}

function mockResponse({ status = 200, json, body }: MockResponseInit): Response {
  const text = body ?? (json === undefined ? '' : JSON.stringify(json));
  const encoded = new TextEncoder().encode(text);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : status === 404 ? 'Not Found' : 'Error',
    headers: { get: () => (json === undefined ? 'application/octet-stream' : 'application/json') },
    json: () => Promise.resolve(json),
    text: () => Promise.resolve(text),
    arrayBuffer: () =>
      Promise.resolve(encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength)),
  } as unknown as Response;
}

/**
 * Slices one bookmark-paginated page out of `items`, ignoring any `limit`
 * the caller passed — see the note at the top of this file.
 *
 * The bookmark is the next offset, so it strictly increases and never
 * repeats: `fetchPage`'s "server returned the same bookmark again" guard is
 * not what any check here is measuring.
 */
function paginate(items: readonly unknown[], url: URL, options: Required<Pick<DaluxMockOptions, 'pageSize' | 'remainingSemantics'>>): unknown {
  const bookmark = url.searchParams.get('bookmark');
  const offset = bookmark === null ? 0 : Number(bookmark);
  const slice = items.slice(offset, offset + options.pageSize);
  const next = offset + slice.length;
  const hasMore = next < items.length;

  const nextUrl = new URL(url.toString());
  nextUrl.searchParams.set('bookmark', String(next));

  const metadata =
    options.remainingSemantics === 'omitted'
      ? undefined
      : {
          totalRemainingItems:
            options.remainingSemantics === 'total' ? items.length : items.length - next,
        };

  return {
    items: slice,
    ...(metadata ? { metadata } : {}),
    ...(hasMore ? { links: [{ rel: 'nextPage', href: nextUrl.toString() }] } : {}),
  };
}

function findProject(world: DaluxMockWorld, projectId: string): DaluxMockProject | undefined {
  return world.projects.find((project) => project.projectId === projectId);
}

function findArea(project: DaluxMockProject | undefined, fileAreaId: string): DaluxMockFileArea | undefined {
  return project?.fileAreas.find((area) => area.fileAreaId === fileAreaId);
}

/** The wire shape of one file row, as both the list and the single-file route send it. */
function fileRow(area: DaluxMockFileArea, file: DaluxMockFile): Record<string, unknown> {
  return {
    fileId: file.fileId,
    fileName: file.fileName,
    fileAreaId: area.fileAreaId,
    folderId: file.folderId ?? null,
    fileRevisionId: file.fileRevisionId ?? null,
    contentHash: file.contentHash ?? null,
    fileType: file.fileType ?? null,
    deleted: file.deleted ?? false,
    lastModified: '2026-08-06T10:00:00Z',
    lastModifiedByUserId: 'user-1',
  };
}

/** URL of the download-link route this mock hands out for a file's current bytes. */
function downloadLinkFor(projectId: string, fileAreaId: string, fileId: string): string {
  return `${DALUX_MOCK_BASE_URL}/download/${encodeURIComponent(projectId)}/${encodeURIComponent(fileAreaId)}/${encodeURIComponent(fileId)}`;
}

/**
 * Builds a `fetch` serving `world` over the Dalux Build REST routes
 * `DaluxBuildProvider` actually calls. Unknown routes answer 404, so a
 * provider change that starts calling an endpoint this mock doesn't model
 * fails loudly instead of silently reading an empty listing.
 */
export function createDaluxApiMock(world: DaluxMockWorld, options: DaluxMockOptions = {}): typeof fetch {
  const paging = {
    pageSize: options.pageSize ?? 1,
    remainingSemantics: options.remainingSemantics ?? ('total' as DaluxRemainingSemantics),
  };

  return ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const signal = init?.signal;
    if (signal?.aborted) {
      return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
    }

    const url = new URL(typeof input === 'string' ? input : input.toString());
    const segments = url.pathname.replace(/^\/service\/api\/?/, '').split('/').map(decodeURIComponent);

    // /5.1/projects
    if (segments[0] === '5.1' && segments[1] === 'projects' && segments.length === 2) {
      const rows = world.projects.map((project) => ({
        data: { projectId: project.projectId, projectName: project.projectName },
      }));
      return Promise.resolve(mockResponse({ json: paginate(rows, url, paging) }));
    }

    const project = segments[1] === 'projects' ? findProject(world, segments[2]) : undefined;

    // /5.1/projects/{p}/file_areas
    if (segments[0] === '5.1' && segments[3] === 'file_areas' && segments.length === 4) {
      if (!project) return Promise.resolve(mockResponse({ status: 404, body: 'no such project' }));
      const rows = project.fileAreas.map((area) => ({
        data: {
          fileAreaId: area.fileAreaId,
          fileAreaName: area.fileAreaName,
          fileAreaType: area.fileAreaType,
        },
      }));
      return Promise.resolve(mockResponse({ json: paginate(rows, url, paging) }));
    }

    const area = findArea(project, segments[4] ?? '');

    // /5.1/projects/{p}/file_areas/{fa}/folders — every folder in the area,
    // regardless of nesting; Dalux has no parent-scoped folder endpoint.
    if (segments[0] === '5.1' && segments[5] === 'folders' && segments.length === 6) {
      if (!area) return Promise.resolve(mockResponse({ status: 404, body: 'no such file area' }));
      const rows = area.folders.map((folder) => ({
        data: {
          folderId: folder.folderId,
          folderName: folder.folderName,
          parentFolderId: folder.parentFolderId ?? null,
        },
      }));
      return Promise.resolve(mockResponse({ json: paginate(rows, url, paging) }));
    }

    // /6.1/projects/{p}/file_areas/{fa}/files — every file in the area. The
    // `folderId` query param is accepted and ignored, exactly as observed:
    // the provider re-filters by each file's own folder for that reason.
    if (segments[0] === '6.1' && segments[5] === 'files' && segments.length === 6) {
      if (!area) return Promise.resolve(mockResponse({ status: 404, body: 'no such file area' }));
      const rows = area.files.map((file) => ({ data: fileRow(area, file) }));
      return Promise.resolve(mockResponse({ json: paginate(rows, url, paging) }));
    }

    // /5.0/projects/{p}/file_areas/{fa}/files/{f} — single file, carrying the
    // download link for its current bytes.
    if (segments[0] === '5.0' && segments[5] === 'files' && segments.length === 7) {
      const file = area?.files.find((candidate) => candidate.fileId === segments[6]);
      if (!area || !project || !file) {
        return Promise.resolve(mockResponse({ status: 404, body: 'no such file' }));
      }
      return Promise.resolve(
        mockResponse({
          json: {
            data: {
              ...fileRow(area, file),
              downloadLink: downloadLinkFor(project.projectId, area.fileAreaId, file.fileId),
            },
          },
        }),
      );
    }

    // /download/{p}/{fa}/{f} — the bytes the link above points at.
    if (segments[0] === 'download' && segments.length === 4) {
      const bytesArea = findArea(findProject(world, segments[1]), segments[2]);
      const file = bytesArea?.files.find((candidate) => candidate.fileId === segments[3]);
      if (!file) return Promise.resolve(mockResponse({ status: 404, body: 'no such file' }));
      return Promise.resolve(mockResponse({ body: file.content }));
    }

    return Promise.resolve(mockResponse({ status: 404, body: `unrouted: ${url.pathname}` }));
  }) as typeof fetch;
}

function createMemoryStorage(): KeyValueStore {
  const store = new Map<string, string>();
  return {
    get: (key) => Promise.resolve(store.get(key)),
    set: (key, value) => {
      store.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => {
      store.delete(key);
      return Promise.resolve();
    },
    keys: () => Promise.resolve([...store.keys()]),
  };
}

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** A `PluginContext` backed by {@link createDaluxApiMock}, with fresh storage per call. */
export function createDaluxMockContext(fetchImpl: typeof fetch): PluginContext {
  return {
    fetch: fetchImpl,
    fetchPublic: () => Promise.reject(new Error('Dalux never uses fetchPublic')),
    getPreference: (name: string) => Promise.resolve(name === 'apiKey' ? 'conformance-key' : undefined),
    storage: createMemoryStorage(),
    log: silentLogger,
  };
}

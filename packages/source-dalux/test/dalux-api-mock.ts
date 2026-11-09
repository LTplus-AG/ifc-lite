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
  /**
   * Names of file properties this folder requires on every new file. Served
   * by the folder properties-mapping route as `requiredOn*: true` rows, which
   * is what makes the provider refuse an upload it cannot satisfy.
   */
  readonly requiredProperties?: readonly string[];
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
  /** Raw `properties` array, echoed on the single-file route. */
  readonly properties?: readonly unknown[];
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
   *
   * Must be a positive integer — `createDaluxApiMock` throws otherwise. A real
   * server never serves a zero-item page and then links to another one.
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

/** Serves file bytes the way a real download does: a streamed body, split
 *  into a few chunks and with no `Content-Length`, so a download exercises
 *  `readWithProgress`'s stream path and its listing-size fallback (#6375). */
function binaryResponse(content: string, headers: Record<string, string> = {}): Response {
  const bytes = new TextEncoder().encode(content);
  const chunkSize = Math.max(1, Math.ceil(bytes.byteLength / 3));
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/octet-stream', ...headers } });
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
    fileSize: new TextEncoder().encode(file.content).byteLength,
    deleted: file.deleted ?? false,
    ...(file.properties ? { properties: file.properties } : {}),
    lastModified: '2026-08-06T10:00:00Z',
    lastModifiedByUserId: 'user-1',
  };
}

/** URL of the download-link route this mock hands out for a file's current bytes. */
function downloadLinkFor(projectId: string, fileAreaId: string, fileId: string): string {
  return `${DALUX_MOCK_BASE_URL}/download/${encodeURIComponent(projectId)}/${encodeURIComponent(fileAreaId)}/${encodeURIComponent(fileId)}`;
}

/** Largest part the real API accepts (spec: 104857600 bytes). */
export const DALUX_MOCK_MAX_PART_BYTES = 104_857_600;

interface UploadSlot {
  readonly fileAreaId: string;
  readonly parts: Uint8Array[];
  received: number;
  total?: number;
}

function toBytes(body: unknown): Uint8Array | undefined {
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return undefined;
}

/** A request body as text, whether the caller sent a string or bytes (a
 *  relay forwards the bytes it read, not the provider's original string). */
function bodyText(body: unknown): string | undefined {
  if (typeof body === 'string') return body;
  const bytes = toBytes(body);
  return bytes ? new TextDecoder().decode(bytes) : undefined;
}

function isUnuploadableArea(area: DaluxMockFileArea): boolean {
  return ['shared', 'published'].includes(area.fileAreaType.toLowerCase());
}

/**
 * Builds a `fetch` serving `world` over the Dalux Build REST routes
 * `DaluxBuildProvider` actually calls. Unknown routes answer 404, so a
 * provider change that starts calling an endpoint this mock doesn't model
 * fails loudly instead of silently reading an empty listing.
 */
export function createDaluxApiMock(initialWorld: DaluxMockWorld, options: DaluxMockOptions = {}): typeof fetch {
  // Uploads mutate the tenant, so serve from a private copy: the caller's
  // `world` constant is shared across tests and must stay pristine.
  const world: DaluxMockWorld = {
    projects: initialWorld.projects.map((project) => ({
      ...project,
      fileAreas: project.fileAreas.map((area) => ({ ...area, files: [...area.files] })),
    })),
  };
  const slots = new Map<string, UploadSlot>();
  let uploadCounter = 0;
  const pageSize = options.pageSize ?? 1;
  // Loudly, at construction. A `pageSize` of 0 makes `paginate` slice an empty
  // page whose bookmark equals the one it was given, so the mock advertises a
  // `nextPage` link that leads back to itself: the caller either spins forever
  // or trips its own repeated-bookmark guard, and the test that configured it
  // fails somewhere far from the mistake. A fractional or non-finite size is
  // just as meaningless to `Array.prototype.slice`. `Number.isInteger` alone
  // covers non-finite (`Number.isInteger(NaN)` and `Number.isInteger(Infinity)`
  // are both false); the `> 0` is what rejects the valid-but-useless zero.
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new TypeError(
      `createDaluxApiMock: pageSize must be a positive integer, got ${String(options.pageSize)}`,
    );
  }
  const paging = {
    pageSize,
    remainingSemantics: options.remainingSemantics ?? ('total' as DaluxRemainingSemantics),
  };

  return ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // `fetch` accepts a string, a `URL` **or** a `Request`, and a `Request`'s
    // `toString()` is `'[object Request]'` — `new URL()` on that throws, so the
    // mock would reject every call made the `Request` way with a parse error
    // rather than serving it. A `Request` also carries its own `signal`, which
    // is the only one an `init`-less call has.
    const request = typeof input === 'object' && input !== null && 'url' in input
      ? (input as Request)
      : undefined;
    const href = request ? request.url : input.toString();
    const signal = init?.signal ?? request?.signal;
    if (signal?.aborted) {
      return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
    }

    const url = new URL(href);
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

    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();

    // Upload step 1: POST /1.0/projects/{p}/file_areas/{fa}/upload
    if (method === 'POST' && segments[0] === '1.0' && segments[5] === 'upload' && segments.length === 6) {
      if (!area || !project) return Promise.resolve(mockResponse({ status: 404, body: 'no such file area' }));
      if (isUnuploadableArea(area)) {
        return Promise.resolve(mockResponse({ status: 400, body: 'file area type does not accept uploads' }));
      }
      uploadCounter += 1;
      const uploadGuid = `upload-${uploadCounter}`;
      slots.set(uploadGuid, { fileAreaId: area.fileAreaId, parts: [], received: 0 });
      return Promise.resolve(mockResponse({ status: 201, json: { data: { uploadGuid } } }));
    }

    // Upload step 2: POST /1.0/projects/{p}/file_areas/{fa}/upload/{guid}
    if (method === 'POST' && segments[0] === '1.0' && segments[5] === 'upload' && segments.length === 7) {
      const slot = slots.get(segments[6]);
      if (!area || !slot || slot.fileAreaId !== area.fileAreaId) {
        return Promise.resolve(mockResponse({ status: 404, body: 'no such upload slot' }));
      }
      const headers = new Headers(init?.headers);
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(headers.get('content-range') ?? '');
      if (!range) return Promise.resolve(mockResponse({ status: 400, body: 'bad Content-Range' }));
      if (!/filename\*=UTF-8''/.test(headers.get('content-disposition') ?? '')) {
        return Promise.resolve(mockResponse({ status: 400, body: 'bad Content-Disposition' }));
      }
      const body = toBytes(init?.body);
      const [start, end, total] = [Number(range[1]), Number(range[2]), Number(range[3])];
      if (!body || body.byteLength !== end - start + 1 || body.byteLength > DALUX_MOCK_MAX_PART_BYTES) {
        return Promise.resolve(mockResponse({ status: 400, body: 'part size does not match Content-Range' }));
      }
      if (start !== slot.received || (slot.total !== undefined && slot.total !== total)) {
        return Promise.resolve(mockResponse({ status: 400, body: 'part out of order' }));
      }
      slot.parts.push(body.slice());
      slot.received += body.byteLength;
      slot.total = total;
      return Promise.resolve(mockResponse({ status: 202 }));
    }

    // Upload step 3: POST /2.0/projects/{p}/file_areas/{fa}/upload/{guid}/finalize
    if (
      method === 'POST' &&
      segments[0] === '2.0' &&
      segments[5] === 'upload' &&
      segments[7] === 'finalize' &&
      segments.length === 8
    ) {
      const slot = slots.get(segments[6]);
      if (!area || !project || !slot) return Promise.resolve(mockResponse({ status: 404, body: 'no such upload slot' }));
      if (slot.total === undefined || slot.received !== slot.total) {
        return Promise.resolve(mockResponse({ status: 400, body: 'upload incomplete' }));
      }
      const meta = JSON.parse(bodyText(init?.body) ?? '{}') as {
        fileName?: string;
        fileType?: string;
        fileId?: string;
        folderId?: string;
        properties?: unknown[];
      };
      if (!meta.fileName || !['document', 'drawing', 'model'].includes(meta.fileType ?? '')) {
        return Promise.resolve(mockResponse({ status: 400, body: 'fileName and a valid fileType are required' }));
      }
      if (Boolean(meta.fileId) === Boolean(meta.folderId)) {
        return Promise.resolve(mockResponse({ status: 400, body: 'exactly one of fileId and folderId' }));
      }
      const bytes = new Uint8Array(slot.received);
      let offset = 0;
      for (const part of slot.parts) {
        bytes.set(part, offset);
        offset += part.byteLength;
      }
      const content = new TextDecoder().decode(bytes);
      const files = area.files as DaluxMockFile[];
      let created: DaluxMockFile;
      if (meta.fileId) {
        const index = files.findIndex((candidate) => candidate.fileId === meta.fileId);
        if (index === -1) return Promise.resolve(mockResponse({ status: 404, body: 'no such file' }));
        created = {
          ...files[index],
          fileRevisionId: `rev-up-${uploadCounter}-${slot.received}`,
          contentHash: undefined,
          content,
          ...(meta.properties ? { properties: meta.properties } : {}),
        };
        files[index] = created;
      } else {
        const isRoot = meta.folderId === area.fileAreaId;
        if (!isRoot && !area.folders.some((folder) => folder.folderId === meta.folderId)) {
          return Promise.resolve(mockResponse({ status: 400, body: 'no such folder' }));
        }
        created = {
          fileId: `file-up-${uploadCounter}`,
          fileName: meta.fileName,
          ...(isRoot ? {} : { folderId: meta.folderId }),
          fileRevisionId: `rev-up-${uploadCounter}-${slot.received}`,
          fileType: meta.fileType,
          content,
          ...(meta.properties ? { properties: meta.properties } : {}),
        };
        files.push(created);
      }
      slots.delete(segments[6]);
      return Promise.resolve(mockResponse({ status: 201, json: { data: fileRow(area, created) } }));
    }

    // /1.1/projects/{p}/file_areas/{fa}/folders/{f}/files/properties/1.0/mappings
    if (
      method === 'GET' &&
      segments[0] === '1.1' &&
      segments[5] === 'folders' &&
      segments[7] === 'files' &&
      segments[10] === 'mappings'
    ) {
      const folder = area?.folders.find((candidate) => candidate.folderId === segments[6]);
      if (!area || !folder) return Promise.resolve(mockResponse({ status: 404, body: 'no such folder' }));
      const rows = (folder.requiredProperties ?? []).map((name) => ({
        data: {
          key: name,
          name,
          valueType: 'text',
          requiredOnDocuments: true,
          requiredOnDrawings: true,
          requiredOnModels: true,
        },
      }));
      return Promise.resolve(mockResponse({ json: paginate(rows, url, paging) }));
    }

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

    // /2.0/projects/{p}/file_areas/{fa}/files/{f}/revisions/{rev}/content —
    // only the current revision is retained (the mock keeps no history).
    if (segments[0] === '2.0' && segments[5] === 'files' && segments[7] === 'revisions' && segments[9] === 'content') {
      const file = area?.files.find((candidate) => candidate.fileId === segments[6]);
      if (!file || (file.fileRevisionId ?? file.contentHash) !== segments[8]) {
        return Promise.resolve(mockResponse({ status: 404, body: 'no such revision' }));
      }
      return Promise.resolve(binaryResponse(file.content));
    }

    // /download/{p}/{fa}/{f} — the bytes the link above points at.
    if (segments[0] === 'download' && segments.length === 4) {
      const bytesArea = findArea(findProject(world, segments[1]), segments[2]);
      const file = bytesArea?.files.find((candidate) => candidate.fileId === segments[3]);
      if (!file) return Promise.resolve(mockResponse({ status: 404, body: 'no such file' }));
      return Promise.resolve(binaryResponse(file.content));
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

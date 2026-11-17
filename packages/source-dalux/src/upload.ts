/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Dalux write-back (#9522): create a slot, send bounded parts, then finalize
 * with fileId (new revision) or folderId (new file). Never both.
 * Conflicts are checked before sending bytes. Dalux offers no conditional
 * finalize, so another writer may still race the preflight check. */

import type {
  SourceFile,
  SourceRevision,
  UploadOptions,
  UploadResult,
  UploadTarget,
} from '@ifc-lite/plugin-api';
import type { PluginContext } from '@ifc-lite/plugin-api';

import { decodeFile, decodeFileArea, decodeFileResponse } from './dalux-types.js';
import type { DaluxFile, DaluxFileArea } from './dalux-types.js';
import {
  BrowserDaluxApiClient,
  DaluxHttpError,
  fetchAllPages,
  type DaluxCredentials,
} from './http-client.js';
import {
  convertListLenient,
  currentRevisionId,
  nonEmptyString,
  LATEST_REVISION,
  decodeContainerId,
  enc,
  toSourceFile,
} from './mapping.js';

/** Largest part the Dalux upload endpoint accepts (spec: 104857600 bytes). */
export const DALUX_MAX_PART_BYTES = 104_857_600;

/**
 * Part size actually sent. In the browser every call goes through the
 * same-origin relay, which caps a relayed body at 4 MiB to stay under the
 * function request-body limit (`MAX_RELAYED_BODY_BYTES` in
 * `server/sources/dalux-relay-upload.ts`). Dalux accepts any part size up to
 * {@link DALUX_MAX_PART_BYTES}, so the smaller part is valid everywhere; it
 * only costs more requests for very large files.
 */
export const DALUX_DEFAULT_PART_BYTES = 4 * 1024 * 1024;

const MAX_FILE_NAME_CHARS = 255;
const MAX_ERROR_BODY_CHARS = 200;

/** Thrown for an upload that cannot proceed and is not a contract conflict:
 * an unsupported file area, a name Dalux would reject, required properties we
 * cannot fill in. The message reaches the user, so it says what to do. */
export class DaluxUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaluxUploadError';
  }
}

export interface DaluxUploadInternals {
  /** Part size override for tests; production uses {@link DALUX_DEFAULT_PART_BYTES}. */
  readonly partSizeBytes?: number;
}

type DaluxFileType = 'document' | 'drawing' | 'model';

/**
 * Dalux's `fileType` for a name.
 *
 * Unverified against the live API: the spec only lists the three values, not
 * which extensions Dalux files under each. IFC is the one that matters here
 * (a model is what the viewer loads), so it is mapped explicitly; the other
 * mappings are conventional and only matter for `new-file` uploads of
 * non-model content.
 */
export function daluxFileTypeFor(fileName: string): DaluxFileType {
  const extension = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase() : '';
  if (['ifc', 'ifczip', 'ifcxml'].includes(extension)) return 'model';
  if (['pdf', 'dwg', 'dxf'].includes(extension)) return 'drawing';
  return 'document';
}

function asDaluxFileType(value: string | undefined): DaluxFileType | undefined {
  return value === 'document' || value === 'drawing' || value === 'model' ? value : undefined;
}

/** A file name Dalux can store: non-empty, no path separators or control characters. */
function validateFileName(fileName: string): string {
  const trimmed = fileName.trim();
  if (!trimmed) throw new DaluxUploadError('A file name is required to save to Dalux.');
  if (trimmed.length > MAX_FILE_NAME_CHARS) {
    throw new DaluxUploadError(`File name is longer than ${MAX_FILE_NAME_CHARS} characters.`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\\/\u0000-\u001f]/.test(trimmed)) {
    throw new DaluxUploadError('A Dalux file name cannot contain slashes or control characters.');
  }
  return trimmed;
}

/** RFC 6266 / 5987 header value: an ASCII fallback plus the exact UTF-8 name. */
export function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `form-data; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function truncate(text: string): string {
  return text.length > MAX_ERROR_BODY_CHARS ? `${text.slice(0, MAX_ERROR_BODY_CHARS)}…` : text;
}

function isNonModelUploadBlocked(area: DaluxFileArea): boolean {
  return ['shared', 'published'].includes(area.fileAreaType.toLowerCase());
}

/**
 * POST helper. Mirrors `BrowserDaluxApiClient.get` (same key header, same
 * relay node selector rule, same error shape) without touching that class, so
 * the read path stays exactly as reviewed.
 */
class DaluxPoster {
  constructor(
    private readonly credentials: DaluxCredentials,
    private readonly ctx: PluginContext,
  ) {}

  async post(
    path: string,
    init: { body?: BodyInit; headers?: Record<string, string>; signal?: AbortSignal },
  ): Promise<Response> {
    const url = new URL(`${this.credentials.baseUrl}${path}`);
    if (this.credentials.node) url.searchParams.set('daluxNode', this.credentials.node);

    const response = await this.ctx.fetch(url.toString(), {
      method: 'POST',
      headers: { 'X-API-KEY': this.credentials.apiKey, Accept: 'application/json', ...init.headers },
      body: init.body,
      signal: init.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      this.ctx.log.error('Dalux POST failed', { path, status: response.status, body });
      throw new DaluxHttpError(
        `Dalux API ${response.status}: ${response.statusText} — ${truncate(body)}`,
        response.status,
      );
    }
    return response;
  }
}

function toSourceRevision(file: DaluxFile, sizeBytes: number): SourceRevision {
  const id = currentRevisionId(file);
  return {
    id,
    label: file.version ?? id,
    // Dalux reports date-only strings; an upload that just happened is "now".
    createdAt: new Date().toISOString(),
    ...(file.lastModifiedByUserId ? { createdBy: file.lastModifiedByUserId } : {}),
    sizeBytes: file.fileSize ?? sizeBytes,
  };
}

async function loadFileArea(
  ctx: PluginContext,
  client: BrowserDaluxApiClient,
  projectId: string,
  fileAreaId: string,
  signal?: AbortSignal,
): Promise<DaluxFileArea> {
  const raw = await fetchAllPages(client, `/5.1/projects/${enc(projectId)}/file_areas`, {}, signal);
  const area = convertListLenient<DaluxFileArea>(ctx, raw, decodeFileArea, 'FileArea').find(
    (candidate) => candidate.fileAreaId === fileAreaId,
  );
  if (!area) throw new DaluxUploadError(`Dalux file area ${fileAreaId} was not found in this project.`);
  if (isNonModelUploadBlocked(area)) {
    throw new DaluxUploadError(
      `Dalux does not accept uploads into "${area.fileAreaName}" (a ${area.fileAreaType} file area). ` +
        'Choose a folder in a regular file area.',
    );
  }
  return area;
}

/**
 * Whether the destination folder demands file properties. We have no UI to
 * collect values, so a required property means the upload would be refused at
 * finalize; saying so up front beats a bare 400 after hundreds of megabytes.
 *
 * Best effort: if the mapping lookup itself fails (older node, relay not
 * routing the version) we proceed and let Dalux's own validation speak.
 */
async function assertNoRequiredProperties(
  ctx: PluginContext,
  client: BrowserDaluxApiClient,
  projectId: string,
  fileAreaId: string,
  folderId: string,
  fileType: DaluxFileType,
  signal?: AbortSignal,
): Promise<void> {
  let rows: unknown[];
  try {
    rows = await fetchAllPages(
      client,
      `/1.1/projects/${enc(projectId)}/file_areas/${enc(fileAreaId)}/folders/${enc(folderId)}/files/properties/1.0/mappings`,
      {},
      signal,
    );
  } catch (err) {
    if (signal?.aborted) throw err;
    ctx.log.warn('Dalux: could not read folder property mappings; continuing without the check', {
      folderId,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const flag = fileType === 'model' ? 'requiredOnModels' : fileType === 'drawing' ? 'requiredOnDrawings' : 'requiredOnDocuments';
  const required = rows
    .map((row) => {
      const record = (row && typeof row === 'object' && 'data' in row ? (row as { data: unknown }).data : row) as
        | Record<string, unknown>
        | null;
      return record && record[flag] === true ? String(record.name ?? record.key ?? 'unnamed') : undefined;
    })
    .filter((name): name is string => name !== undefined);

  if (required.length > 0) {
    throw new DaluxUploadError(
      `This Dalux folder requires file properties (${required.join(', ')}) that ifc-lite cannot fill in yet. ` +
        'Save into a folder without required properties, or add a new version of an existing file instead.',
    );
  }
}

export async function uploadToDalux(
  ctx: PluginContext,
  credentials: DaluxCredentials,
  target: UploadTarget,
  bytes: ArrayBuffer,
  options?: UploadOptions,
  internals: DaluxUploadInternals = {},
): Promise<UploadResult> {
  const signal = options?.signal;
  const total = bytes.byteLength;
  if (total === 0) throw new DaluxUploadError('Refusing to upload an empty file to Dalux.');

  const partSize = internals.partSizeBytes ?? DALUX_DEFAULT_PART_BYTES;
  if (!Number.isInteger(partSize) || partSize <= 0 || partSize > DALUX_MAX_PART_BYTES) {
    throw new RangeError(`Dalux part size must be an integer in 1..${DALUX_MAX_PART_BYTES}`);
  }

  const client = new BrowserDaluxApiClient(credentials, ctx);
  const poster = new DaluxPoster(credentials, ctx);

  let projectId: string;
  let fileAreaId: string;
  let fileName: string;
  let fileType: DaluxFileType;
  let finalizeTarget: { fileId: string } | { folderId: string };
  let carriedProperties: unknown[] | undefined;

  if (target.mode === 'new-version') {
    const { ref } = target;
    projectId = ref.projectId;
    fileAreaId = decodeContainerId(ref.containerId).fileAreaId;

    const response = await client.get(
      `/5.0/projects/${enc(projectId)}/file_areas/${enc(fileAreaId)}/files/${enc(ref.fileId)}`,
      {},
      signal,
    );
    const current = decodeFileResponse(response).data;
    if (current.deleted) throw new DaluxUploadError('That Dalux file has been deleted; save it as a new file instead.');

    if (target.baseRevisionId !== undefined) {
      const base = nonEmptyString(target.baseRevisionId);
      const identities = [nonEmptyString(current.fileRevisionId), nonEmptyString(current.contentHash)].filter((id): id is string => id !== undefined && id !== LATEST_REVISION);
      if (!base || base === LATEST_REVISION || identities.length === 0) {
        throw new DaluxUploadError('Cannot verify the base revision; reload a file with a revision identity before saving.');
      }
      // A listing can expose the hash while the file response also has an ID.
      if (!identities.includes(base)) return { ok: false, conflict: { kind: 'stale-base', currentRevisionId: currentRevisionId(current) } };
    }

    await loadFileArea(ctx, client, projectId, fileAreaId, signal);

    fileName = current.fileName;
    fileType = asDaluxFileType(current.fileType) ?? daluxFileTypeFor(fileName);
    finalizeTarget = { fileId: ref.fileId };
    // A new revision keeps the file's metadata: resend its properties as-is so
    // a folder with required properties does not reject the new revision.
    const rawProperties = ((response as { data?: { properties?: unknown } }).data ?? {}).properties;
    if (Array.isArray(rawProperties) && rawProperties.length > 0) carriedProperties = rawProperties;
  } else {
    projectId = target.projectId;
    const container = decodeContainerId(target.containerId);
    fileAreaId = container.fileAreaId;
    fileName = validateFileName(target.fileName);
    fileType = daluxFileTypeFor(fileName);
    // The area root has no folder of its own. Dalux reports root-level
    // folders with the file area id as their parent, so the area id is the
    // root's folder id. Unverified against the live API.
    const folderId = container.folderId ?? fileAreaId;
    finalizeTarget = { folderId };

    await loadFileArea(ctx, client, projectId, fileAreaId, signal);

    // Same listing `listFiles` uses. Dalux ignores the folder filter, so this
    // sweeps the whole area and compares each file's own folder.
    const rawFiles = await fetchAllPages(
      client,
      `/6.1/projects/${enc(projectId)}/file_areas/${enc(fileAreaId)}/files`,
      {},
      signal,
    );
    const wanted = fileName.toLowerCase();
    const clash = convertListLenient<DaluxFile>(ctx, rawFiles, decodeFile, 'File').find(
      (file) =>
        !file.deleted &&
        toSourceFile(fileAreaId, file).containerId === target.containerId &&
        file.fileName.toLowerCase() === wanted,
    );
    if (clash) return { ok: false, conflict: { kind: 'name-exists', existingFileId: clash.fileId } };

    if (container.folderId) {
      await assertNoRequiredProperties(ctx, client, projectId, fileAreaId, container.folderId, fileType, signal);
    }
  }

  signal?.throwIfAborted();

  const slotResponse = await poster.post(
    `/1.0/projects/${enc(projectId)}/file_areas/${enc(fileAreaId)}/upload`,
    { signal },
  );
  const slotJson = (await slotResponse.json()) as { data?: { uploadGuid?: unknown } };
  const uploadGuid = slotJson.data?.uploadGuid;
  if (typeof uploadGuid !== 'string' || !uploadGuid) {
    throw new DaluxUploadError('Dalux did not return an upload slot.');
  }

  const disposition = contentDisposition(fileName);
  const content = new Uint8Array(bytes);
  for (let start = 0; start < total; start += partSize) {
    signal?.throwIfAborted();
    const end = Math.min(start + partSize, total) - 1;
    await poster.post(
      `/1.0/projects/${enc(projectId)}/file_areas/${enc(fileAreaId)}/upload/${enc(uploadGuid)}`,
      {
        // Copy out of the caller's buffer: the part must not alias bytes the
        // host may keep mutating while the request is in flight.
        body: content.slice(start, end + 1),
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': disposition,
          'Content-Range': `bytes ${start}-${end}/${total}`,
        },
        signal,
      },
    );
    options?.onProgress?.(end + 1, total);
  }

  signal?.throwIfAborted();
  const finalizeResponse = await poster.post(
    `/2.0/projects/${enc(projectId)}/file_areas/${enc(fileAreaId)}/upload/${enc(uploadGuid)}/finalize`,
    {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName,
        fileType,
        ...finalizeTarget,
        ...(carriedProperties ? { properties: carriedProperties } : {}),
      }),
      signal,
    },
  );
  const created = decodeFileResponse(await finalizeResponse.json()).data;

  const file: SourceFile = toSourceFile(fileAreaId, created);
  return { ok: true, file, revision: toSourceRevision(created, total) };
}

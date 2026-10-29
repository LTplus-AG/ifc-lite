/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * SPIKE: BIMcollab Documents API client (BimCollabPublicApi v1).
 *
 * The Documents API accepts the same bearer token as the BCF Connection API
 * (scope `openid offline_access bcf`), so an existing BIMcollab BCF session
 * can browse and download a space's documents without a second sign-in.
 * Requests are scoped by the space GUID, which BIMcollab carries inside the
 * access token, and go to a regional host rather than the space URL:
 *
 *   https://api.eu.bimcollab.com/spaces/<space-id>/documents/v1/<path>
 *
 * The host's CORS preflight omits `Access-Control-Allow-Headers`, so a
 * browser cannot send `Authorization` to it directly (verified 2026-10-29);
 * in the viewer, `apiHost` must point at a same-origin proxy. A download is two
 * hops: the API returns a pre-signed blob URL, which is fetched WITHOUT the
 * bearer token (forwarding it to blob storage would leak it).
 *
 * Contract: https://api.eu.bimcollab.com/BimCollabPublicApi/v1/swagger/BimCollabPublicApi-v1.swagger.json
 */

export const BIMCOLLAB_DOCUMENTS_DEFAULT_HOST = 'https://api.eu.bimcollab.com';

export interface BimcollabDocumentsClientOptions {
  spaceId: string;
  getAccessToken: () => string | Promise<string>;
  /** Regional API host; defaults to the EU host. */
  apiHost?: string;
  fetchFn?: typeof fetch;
}

export interface BimcollabProjectPhase { projectPhaseId: string; name: string; code?: string | null }
export interface BimcollabProject {
  projectId: string;
  name: string;
  code?: string | null;
  currentProjectPhaseName?: string | null;
  projectPhases?: BimcollabProjectPhase[] | null;
}
export interface BimcollabLocation { locationId: string; name: string; code?: string | null; projects?: BimcollabProject[] | null }
export interface BimcollabProjectStructure {
  locationGroups?: unknown[] | null;
  locations?: BimcollabLocation[] | null;
}

export interface BimcollabDocumentVersion {
  documentVersionId: string;
  documentId: string;
  versionNumber?: string | null;
  versionDate?: string | null;
  modifiedDate?: string | null;
  modificationDescription?: string | null;
  publishState?: string | null;
  fileName?: string | null;
}

export interface BimcollabDocument {
  documentId: string;
  documentNumber?: string | null;
  documentType?: string | null;
  description1?: string | null;
  modifiedDate?: string | null;
  archived?: boolean;
  latestVersion?: BimcollabDocumentVersion | null;
}

export interface BimcollabDownload { downloadUrl: string; fileName: string }

export type BimcollabDocumentScope = { projectId: string } | { projectPhaseId: string };

export class BimcollabDocumentsError extends Error {
  constructor(message: string, readonly status: number, readonly detail?: unknown) {
    super(message);
    this.name = 'BimcollabDocumentsError';
  }
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    const json = new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
    const payload: unknown = JSON.parse(json);
    return payload && typeof payload === 'object' ? payload as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * Space GUID carried by a BIMcollab access token, in the `spaceGuid` claim
 * (verified on playground.bimcollab.com, 2026-10-29). Other `*space*` GUID
 * claims are accepted as a fallback in case a deployment names it
 * differently. Returns '' when none is found.
 */
export function spaceIdFromAccessToken(token: string): string {
  const payload = decodeJwtPayload(token);
  if (!payload) return '';
  const claims = Object.entries(payload).sort(([a], [b]) => Number(b === 'spaceGuid') - Number(a === 'spaceGuid'));
  for (const [claim, value] of claims) {
    if (!/space/i.test(claim)) continue;
    const candidates = Array.isArray(value) ? value : [value];
    const guid = candidates.find((v): v is string => typeof v === 'string' && GUID.test(v));
    if (guid) return guid.toLowerCase();
  }
  return '';
}

/** Whether a saved BCF server URL is a BIMcollab space. */
export function isBimcollabServerUrl(serverUrl: string): boolean {
  try {
    const host = new URL(serverUrl).hostname.toLowerCase();
    return host === 'bimcollab.com' || host.endsWith('.bimcollab.com');
  } catch {
    return false;
  }
}

const MODEL_EXTENSIONS = /\.(ifc|ifczip|ifcxml|ifcx)$/i;

/** Whether a document's latest version is a model the viewer can open. */
export function isOpenableModelDocument(document: BimcollabDocument): boolean {
  return MODEL_EXTENSIONS.test(document.latestVersion?.fileName ?? '');
}

const PAGE_SIZE = 100;

export class BimcollabDocumentsClient {
  private readonly base: string;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: BimcollabDocumentsClientOptions) {
    if (!GUID.test(options.spaceId)) throw new Error('A BIMcollab space id must be a GUID.');
    const host = (options.apiHost ?? BIMCOLLAB_DOCUMENTS_DEFAULT_HOST).replace(/\/+$/, '');
    if (!host.startsWith('https://')) throw new Error('The BIMcollab API host must use https.');
    this.base = `${host}/spaces/${options.spaceId}/documents/v1`;
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await this.options.getAccessToken();
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    headers.set('Accept', 'application/json');
    // The swagger contract still declares the space as a header; the path
    // form is what the guides use. Sending both is harmless.
    headers.set('bimcollab-space-guid', this.options.spaceId);
    const response = await this.fetchFn(`${this.base}${path}`, { ...init, headers });
    if (!response.ok) {
      let detail: unknown;
      try { detail = await response.json(); } catch { /* non-JSON error body */ }
      const title = (detail as { title?: unknown } | undefined)?.title;
      throw new BimcollabDocumentsError(
        `BIMcollab Documents API ${init.method ?? 'GET'} ${path} failed (${response.status})${typeof title === 'string' ? `: ${title}` : ''}`,
        response.status,
        detail,
      );
    }
    return await response.json() as T;
  }

  /** limit/offset paging until a short page. */
  private async collect<T>(path: string, query: URLSearchParams = new URLSearchParams()): Promise<T[]> {
    const all: T[] = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      query.set('limit', String(PAGE_SIZE));
      query.set('offset', String(offset));
      const page = await this.request<T[]>(`${path}?${query}`);
      all.push(...page);
      if (page.length < PAGE_SIZE) return all;
    }
  }

  getProjectStructure(): Promise<BimcollabProjectStructure> {
    return this.request('/project-structure');
  }

  listDocuments(scope: BimcollabDocumentScope, filter: { searchText?: string } = {}): Promise<BimcollabDocument[]> {
    const query = new URLSearchParams();
    if (filter.searchText) query.set('searchText', filter.searchText);
    const path = 'projectId' in scope
      ? `/projects/${encodeURIComponent(scope.projectId)}/documents`
      : `/project-phases/${encodeURIComponent(scope.projectPhaseId)}/documents`;
    return this.collect(path, query);
  }

  listVersions(documentId: string): Promise<BimcollabDocumentVersion[]> {
    return this.request(`/documents/${encodeURIComponent(documentId)}/document-versions`);
  }

  /** Pre-signed URL of a document's latest version, or of a specific version. */
  getDownload(ref: { documentId: string } | { documentVersionId: string }): Promise<BimcollabDownload> {
    return this.request('documentId' in ref
      ? `/documents/${encodeURIComponent(ref.documentId)}/download`
      : `/document-versions/${encodeURIComponent(ref.documentVersionId)}/download`);
  }

  /**
   * Download a document (version) as a File for the viewer's loader. The
   * blob fetch deliberately carries no credentials.
   */
  async downloadFile(
    ref: { documentId: string } | { documentVersionId: string },
    signal?: AbortSignal,
  ): Promise<File> {
    const { downloadUrl, fileName } = await this.getDownload(ref);
    if (!downloadUrl.startsWith('https://')) throw new Error('BIMcollab returned a non-https download URL.');
    const response = await this.fetchFn(downloadUrl, { signal, credentials: 'omit' });
    if (!response.ok) {
      throw new BimcollabDocumentsError(`Downloading ${fileName} failed (${response.status})`, response.status);
    }
    return new File([await response.blob()], fileName);
  }
}

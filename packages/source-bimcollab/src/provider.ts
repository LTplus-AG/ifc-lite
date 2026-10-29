/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readWithProgress, type DownloadOptions, type FileFilter, type FileSourceProvider,
  type ListOptions, type ListProjectsOptions, type PluginContext, type SourceFileRef } from '@ifc-lite/plugin-api';
import { BIMCOLLAB_MANIFEST } from './manifest.js';
import { BimcollabHttpError, checked, RelayBimcollabTransport, type BimcollabTransport } from './http-client.js';
import { LegacyDownload } from './legacy-download.js';
import { modelFile, paging } from './mapping.js';
import type { BimcollabSession, Document, Structure, Version } from './types.js';

export interface BimcollabProviderOptions {
  readonly session: BimcollabSession;
  readonly transport?: BimcollabTransport;
  readonly relayBaseUrl?: string;
  readonly legacyDownloadFallback?: boolean;
}
const enc = encodeURIComponent;
const ROOT = 'root';

export class BimcollabProvider implements FileSourceProvider {
  readonly manifest = BIMCOLLAB_MANIFEST;
  private readonly transport: BimcollabTransport;
  private readonly legacy: LegacyDownload;
  constructor(private readonly options: BimcollabProviderOptions) {
    if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(options.session.spaceGuid)) throw new Error('BIMcollab spaceGuid must be a GUID.');
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(options.session.spaceLabel)) throw new Error('BIMcollab spaceLabel must be a single DNS label.');
    this.transport = options.transport ?? new RelayBimcollabTransport(options.relayBaseUrl);
    this.legacy = new LegacyDownload(this.transport);
  }
  private async json<T>(ctx: PluginContext, path: string, signal?: AbortSignal): Promise<T> {
    return await (await checked(await this.transport.docs(ctx, this.options.session, path, signal))).json() as T;
  }
  private async structure(ctx: PluginContext, signal?: AbortSignal) {
    const structure = await this.json<Structure>(ctx, 'project-structure', signal);
    return (structure.locations ?? []).flatMap(location => (location.projects ?? []).map(project => ({ location, project })));
  }
  async listProjects(ctx: PluginContext, options?: ListProjectsOptions) {
    const rows = await this.structure(ctx, options?.signal);
    return { items: rows.filter(({ project }) => !options?.query || project.name.toLowerCase().includes(options.query.toLowerCase()))
      .map(({ location, project }) => ({ id: project.projectId, name: project.name,
        meta: { locationId: location.locationId, locationName: location.name } })) };
  }
  async listContainers(ctx: PluginContext, projectId: string, parentId?: string, options?: ListOptions) {
    if (parentId) return { items: [] };
    const row = (await this.structure(ctx, options?.signal)).find(row => row.project.projectId === projectId);
    if (!row) throw new Error('BIMcollab project is no longer accessible.');
    const phases = row.project.projectPhases ?? [];
    // Documents can be attached to the project itself as well as to a phase,
    // so the project-level container is always offered, then each phase.
    return { items: [{ id: ROOT, name: row.project.name, hasChildren: false },
      ...phases.map(phase => ({ id: phase.projectPhaseId, name: phase.name, hasChildren: false }))] };
  }
  private async documents(ctx: PluginContext, projectId: string, containerId: string, options?: ListOptions, query?: string) {
    const { offset, limit } = paging(options?.cursor, options?.limit);
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (query) params.set('searchText', query);
    const path = containerId === ROOT ? `projects/${enc(projectId)}` : `project-phases/${enc(containerId)}`;
    const documents = await this.json<Document[]>(ctx, `${path}/documents?${params}`, options?.signal);
    return { documents, cursor: documents.length === limit ? String(offset + limit) : undefined };
  }
  async listFiles(ctx: PluginContext, projectId: string, containerId: string, filter?: FileFilter, options?: ListOptions) {
    const page = await this.documents(ctx, projectId, containerId, options);
    return { items: page.documents.flatMap(doc => { const file = modelFile(doc, containerId, filter); return file ? [file] : []; }), cursor: page.cursor };
  }
  /**
   * Searches every container of the project: the project level, then each phase
   * (phase-attached documents are only listed under their phase). The cursor is
   * `<containerIndex>:<offset>`, so paging walks one container after another and
   * every hit carries its real container id for download.
   */
  async searchFiles(ctx: PluginContext, projectId: string, query: string, filter?: FileFilter, options?: ListOptions) {
    const containers = (await this.listContainers(ctx, projectId, undefined, options)).items.map(item => item.id);
    const [indexText, offsetText] = (options?.cursor ?? '0:0').split(':');
    const index = Number(indexText);
    if (!Number.isSafeInteger(index) || index < 0 || index >= containers.length || offsetText === undefined) {
      throw new Error('Invalid BIMcollab search cursor.');
    }
    const containerId = containers[index]!;
    const page = await this.documents(ctx, projectId, containerId, { ...options, cursor: offsetText }, query);
    const cursor = page.cursor !== undefined ? `${index}:${page.cursor}`
      : index + 1 < containers.length ? `${index + 1}:0` : undefined;
    return { items: page.documents.flatMap(doc => { const file = modelFile(doc, containerId, filter); return file ? [file] : []; }), cursor };
  }
  async listRevisions(ctx: PluginContext, ref: SourceFileRef, options?: ListOptions) {
    const versions = await this.json<Version[]>(ctx, `documents/${enc(ref.fileId)}/document-versions`, options?.signal);
    return { items: [...versions].sort((a, b) => (b.versionDate ?? b.modifiedDate ?? '').localeCompare(a.versionDate ?? a.modifiedDate ?? ''))
      .map(version => ({ id: version.documentVersionId, label: version.versionNumber ?? version.documentVersionId,
        createdAt: version.versionDate ?? version.modifiedDate ?? '' })) };
  }
  async download(ctx: PluginContext, ref: SourceFileRef, options?: DownloadOptions): Promise<ArrayBuffer> {
    options?.signal?.throwIfAborted();
    options?.onPhase?.('preparing');
    let response: Response;
    try {
      const path = ref.revisionId ? `document-versions/${enc(ref.revisionId)}/download` : `documents/${enc(ref.fileId)}/download`;
      const result = await this.json<{ downloadUrl: string }>(ctx, path, options?.signal);
      const url = new URL(result.downloadUrl);
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('BIMcollab returned an invalid HTTPS download URL.');
      response = await checked(await ctx.fetchPublic(url.href, { signal: options?.signal }));
    } catch (error) {
      if (!(error instanceof BimcollabHttpError) || !error.downloadUnavailable || this.options.legacyDownloadFallback === false) throw error;
      response = await this.fallback(ctx, ref, options?.signal);
    }
    options?.signal?.throwIfAborted();
    options?.onPhase?.('downloading');
    return readWithProgress(await checked(response), options?.onProgress);
  }
  private async fallback(ctx: PluginContext, ref: SourceFileRef, signal?: AbortSignal) {
    const row = (await this.structure(ctx, signal)).find(row => row.project.projectId === ref.projectId);
    if (!row) throw new Error('BIMcollab project is no longer accessible.');
    let document: Document | undefined;
    let cursor: string | undefined;
    for (let pageCount = 0; pageCount < 1000; pageCount++) {
      const page = await this.documents(ctx, ref.projectId, ref.containerId, { cursor, signal });
      document = page.documents.find(doc => doc.documentId === ref.fileId);
      cursor = page.cursor;
      if (document || !cursor) break;
    }
    if (!document || document.archived || document.confidential) throw new Error('BIMcollab document is unavailable or the lookup limit was reached.');
    const version = ref.revisionId
      ? (await this.json<Version[]>(ctx, `documents/${enc(ref.fileId)}/document-versions`, signal)).find(v => v.documentVersionId === ref.revisionId)
      : document.latestVersion;
    if (!document.documentNumber || !version?.versionNumber) throw new Error('BIMcollab legacy download needs a document number and version number.');
    return this.legacy.download(ctx, this.options.session, { location: row.location.name, project: row.project.name,
      phases: (row.project.projectPhases ?? []).map(phase => phase.name),
      // The web-app index lists current versions only. Rows without a project
      // (phase-attached) are only safe to match when the CURRENT version is
      // requested, because then the right row is guaranteed to be present.
      latest: !ref.revisionId || ref.revisionId === document.latestVersion?.documentVersionId,
      locationGuid: row.location.locationId }, document.documentNumber, version.versionNumber, signal);
  }
}

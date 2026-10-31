/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  matchesGlob, readWithProgress, type DownloadOptions, type FileFilter, type FileSourceProvider, type ListOptions,
  type ListProjectsOptions, type PluginContext, type SourceFile, type SourceFileRef,
} from '@ifc-lite/plugin-api';
import { BuildagilAuth } from './auth.js';
import { BuildagilClient } from './http-client.js';
import { BUILDAGIL_MANIFEST } from './manifest.js';
import { folderTree, MODEL_FILE, scanModelDocuments } from './scan.js';
import { decodeProject, decodeSearch, decodeVersion, rows, type BuildagilDocument } from './types.js';

export interface BuildagilProviderOptions {
  /** The deployment's buildagil OAuth client id; empty = sign-in not configured. */
  readonly clientId: string;
  /** Callback path registered with buildagil; defaults to `/oauth/bcf/callback`. */
  readonly redirectPath?: string;
}

/** A project's scan is reused this long, so browsing folders costs one scan. */
const SCAN_TTL_MS = 60_000;
const SEARCH_LIMIT_MAX = 200;
const enc = encodeURIComponent;

function toFile(doc: BuildagilDocument): SourceFile {
  return {
    id: doc.guid, name: doc.filename, containerId: doc.folder, sizeBytes: doc.sizeBytes,
    currentRevisionId: String(doc.versionIndex), modifiedAt: doc.modifiedAt, modifiedBy: doc.modifiedBy,
    meta: { versionNumber: doc.versionNumber, status: doc.status, link: doc.link },
  };
}

function accepts(name: string, filter?: FileFilter): boolean {
  return MODEL_FILE.test(name) && (!filter?.namePatterns?.length || filter.namePatterns.some((pattern) => matchesGlob(name, pattern)));
}

/** One page of a list the API returned whole, `cursor` being the offset. */
function slice<T>(items: readonly T[], options?: ListOptions, max = 500): { items: T[]; cursor?: string } {
  const { offset, limit } = offsetPage(options?.cursor, options?.limit, max);
  return { items: items.slice(offset, offset + limit), cursor: offset + limit < items.length ? String(offset + limit) : undefined };
}

function offsetPage(cursor: string | undefined, requested: number | undefined, max: number): { offset: number; limit: number } {
  const offset = cursor === undefined ? 0 : Number(cursor);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid buildagil paging cursor.');
  return { offset, limit: Math.max(1, Math.min(max, Math.floor(requested ?? 100))) };
}

export class BuildagilProvider implements FileSourceProvider {
  readonly manifest = BUILDAGIL_MANIFEST;
  readonly auth: BuildagilAuth;
  private readonly client: BuildagilClient;
  private readonly scans = new Map<string, { at: number; documents: Promise<BuildagilDocument[]> }>();

  constructor(options: BuildagilProviderOptions) {
    // A scan belongs to the account that made it.
    this.auth = new BuildagilAuth(options.clientId, options.redirectPath, () => this.scans.clear());
    this.client = new BuildagilClient((ctx) => this.auth.accessToken(ctx));
  }

  private documents(ctx: PluginContext, projectId: string, signal?: AbortSignal): Promise<BuildagilDocument[]> {
    const cached = this.scans.get(projectId);
    if (cached && Date.now() - cached.at < SCAN_TTL_MS) return cached.documents;
    const documents = scanModelDocuments(ctx, this.client, projectId, signal);
    this.scans.set(projectId, { at: Date.now(), documents });
    // A failed or aborted scan is not cached.
    documents.catch(() => { if (this.scans.get(projectId)?.documents === documents) this.scans.delete(projectId); });
    return documents;
  }

  async listProjects(ctx: PluginContext, options?: ListProjectsOptions) {
    const projects = rows(await this.client.json(ctx, '1.0/projects', { signal: options?.signal }), decodeProject);
    const query = options?.query?.toLowerCase();
    return slice(projects
      .filter((project) => !query || project.name.toLowerCase().includes(query) || project.number?.toLowerCase().includes(query))
      .map((project) => ({ id: project.id, name: project.name, meta: { number: project.number, location: project.location, link: project.link } })),
    options);
  }

  /** `flat-subtree`: the whole folder tree below `parentId` (or all of it) in one call. */
  async listContainers(ctx: PluginContext, projectId: string, parentId?: string, options?: ListOptions) {
    const tree = folderTree(await this.documents(ctx, projectId, options?.signal));
    return slice(parentId ? tree.filter((folder) => folder.id.startsWith(`${parentId}/`)) : tree, options);
  }

  async listFiles(ctx: PluginContext, projectId: string, containerId: string, filter?: FileFilter, options?: ListOptions) {
    const files = (await this.documents(ctx, projectId, options?.signal))
      .filter((doc) => doc.folder === containerId && accepts(doc.filename, filter))
      .sort((a, b) => a.filename.localeCompare(b.filename))
      .map(toFile);
    return slice(files, options);
  }

  async searchFiles(ctx: PluginContext, projectId: string, query: string, filter?: FileFilter, options?: ListOptions) {
    const { offset, limit } = offsetPage(options?.cursor, options?.limit, SEARCH_LIMIT_MAX);
    const result = decodeSearch(await this.client.json(ctx, '1.0/search', {
      method: 'POST', signal: options?.signal,
      body: { targets: ['Document'], search_text: query, project_ids: [projectId], limit, offset },
    }));
    // Filtered pages may come back empty while the cursor still advances.
    return {
      items: result.documents.filter((doc) => accepts(doc.filename, filter)).map(toFile),
      cursor: offset + limit < result.total ? String(offset + limit) : undefined,
    };
  }

  async listRevisions(ctx: PluginContext, ref: SourceFileRef, options?: ListOptions) {
    const versions = rows(await this.client.json(ctx,
      `1.0/projects/${enc(ref.projectId)}/documents/${enc(ref.fileId)}/versions`, { signal: options?.signal }), decodeVersion);
    return slice(versions.sort((a, b) => b.index - a.index).map((version) => ({
      id: String(version.index), label: version.number ? `Version ${version.number}` : `Version ${version.index}`,
      createdAt: version.modifiedAt ?? '', createdBy: version.modifiedBy, sizeBytes: version.sizeBytes,
    })), options);
  }

  /**
   * A named revision is fetched by its index, so an older version is never
   * answered with newer bytes; without one, the current content.
   */
  async download(ctx: PluginContext, ref: SourceFileRef, options?: DownloadOptions) {
    if (ref.revisionId !== undefined && !/^(?:0|[1-9][0-9]{0,8})$/.test(ref.revisionId)) {
      throw new Error('Invalid buildagil revision.');
    }
    const base = `1.0/projects/${enc(ref.projectId)}/documents/${enc(ref.fileId)}`;
    options?.onPhase?.('downloading');
    const response = await this.client.request(ctx, ref.revisionId === undefined ? base : `${base}/versions/${ref.revisionId}`,
      { accept: 'application/octet-stream', signal: options?.signal });
    return readWithProgress(response, options?.onProgress);
  }
}

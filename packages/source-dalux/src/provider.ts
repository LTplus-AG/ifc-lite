/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type {
  ConnectionTestResult,
  FileFilter,
  FileSourceProvider,
  PluginContext,
  RevisionEvent,
  SourceContainer,
  SourceFile,
  SourceProject,
  SourceRevision,
} from '@ifc-lite/plugin-api';

import { DALUX_MANIFEST } from './manifest.js';
import { ENDPOINTS } from './endpoints.js';

// ---------------------------------------------------------------------------
// Dalux Build API response shapes (subset we use)
// ---------------------------------------------------------------------------

interface DaluxProject {
  Id: string;
  Name: string;
  Description?: string;
}

interface DaluxFileArea {
  Id: string;
  Name: string;
}

interface DaluxFolder {
  Id: string;
  Name: string;
  ParentFolderId?: string | null;
}

interface DaluxFile {
  Id: string;
  Name: string;
  FileAreaId: string;
  MimeType?: string;
  Size?: number;
  CurrentRevision?: DaluxRevision;
  Revisions?: DaluxRevision[];
}

interface DaluxRevision {
  Id: string;
  Version: number;
  CreatedAt: string;
  CreatedBy?: string;
  Size?: number;
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

export class DaluxBuildProvider implements FileSourceProvider {
  readonly manifest = DALUX_MANIFEST;

  async listProjects(ctx: PluginContext): Promise<SourceProject[]> {
    const data = await this.get<DaluxProject[]>(ctx, ENDPOINTS.projects());
    return data.map((p) => ({
      id: p.Id,
      name: p.Name,
      description: p.Description,
    }));
  }

  async listContainers(ctx: PluginContext, projectId: string): Promise<SourceContainer[]> {
    const [fileAreas, folders] = await Promise.all([
      this.get<DaluxFileArea[]>(ctx, ENDPOINTS.fileAreas(projectId)),
      this.listAllFolders(ctx, projectId),
    ]);

    const containers: SourceContainer[] = fileAreas.map((fa) => ({
      id: fa.Id,
      name: fa.Name,
      meta: { kind: 'file-area' },
    }));

    for (const f of folders) {
      containers.push({
        id: f.Id,
        name: f.Name,
        parentId: f.ParentFolderId ?? undefined,
        meta: { kind: 'folder' },
      });
    }

    return containers;
  }

  async listFiles(
    ctx: PluginContext,
    containerId: string,
    filter?: FileFilter,
  ): Promise<SourceFile[]> {
    const projectId = await this.resolveProjectForContainer(ctx, containerId);
    if (!projectId) return [];

    const data = await this.get<DaluxFile[]>(
      ctx,
      ENDPOINTS.files(projectId, containerId),
    );

    let files = data.map((f) => toSourceFile(f));

    if (filter?.namePatterns?.length) {
      files = files.filter((f) =>
        filter.namePatterns!.some((pat) => matchGlob(pat, f.name)),
      );
    }
    if (filter?.mimeTypes?.length) {
      files = files.filter(
        (f) => f.mimeType && filter.mimeTypes!.includes(f.mimeType),
      );
    }

    return files;
  }

  async download(
    ctx: PluginContext,
    fileId: string,
    revisionId?: string,
  ): Promise<ArrayBuffer> {
    const loc = await this.resolveFileLocation(ctx, fileId);
    if (!loc) throw new Error(`Cannot resolve location for file ${fileId}`);

    const url = revisionId
      ? ENDPOINTS.revisionDownload(loc.projectId, loc.fileAreaId, fileId, revisionId)
      : ENDPOINTS.fileDownload(loc.projectId, loc.fileAreaId, fileId);

    const res = await this.authedFetch(ctx, url);
    if (!res.ok) {
      throw new Error(
        `Download failed: ${res.status} ${res.statusText}`,
      );
    }
    return res.arrayBuffer();
  }

  async checkRevisions(
    ctx: PluginContext,
    fileIds: string[],
  ): Promise<RevisionEvent[]> {
    const events: RevisionEvent[] = [];

    for (const fileId of fileIds) {
      const cached = await ctx.storage.get(`rev:${fileId}`);
      const loc = await this.resolveFileLocation(ctx, fileId);
      if (!loc) continue;

      const files = await this.get<DaluxFile[]>(
        ctx,
        ENDPOINTS.files(loc.projectId, loc.fileAreaId),
      );
      const match = files.find((f) => f.Id === fileId);
      if (!match?.CurrentRevision) continue;

      const latestId = match.CurrentRevision.Id;
      if (cached && cached !== latestId) {
        events.push({
          fileId,
          latestRevisionId: latestId,
          previousRevisionId: cached,
        });
      }

      await ctx.storage.set(`rev:${fileId}`, latestId);
    }

    return events;
  }

  async testConnection(ctx: PluginContext): Promise<ConnectionTestResult> {
    try {
      const projects = await this.listProjects(ctx);
      return {
        ok: true,
        message: `Connected — ${projects.length} project${projects.length === 1 ? '' : 's'} accessible.`,
        projectCount: projects.length,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('403')) {
        return {
          ok: false,
          message:
            'Your API identity lacks access. Check that the identity is assigned to a user group with project permissions.',
        };
      }
      return { ok: false, message: msg };
    }
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private async listAllFolders(
    ctx: PluginContext,
    projectId: string,
  ): Promise<DaluxFolder[]> {
    const fileAreas = await this.get<DaluxFileArea[]>(
      ctx,
      ENDPOINTS.fileAreas(projectId),
    );
    const all: DaluxFolder[] = [];
    for (const fa of fileAreas) {
      const folders = await this.get<DaluxFolder[]>(
        ctx,
        ENDPOINTS.folders(projectId, fa.Id),
      );
      all.push(...folders);
    }
    return all;
  }

  /**
   * Resolve the projectId + fileAreaId for a container id. Uses the storage
   * cache set during `listContainers`/`listFiles` to avoid redundant lookups.
   */
  private async resolveProjectForContainer(
    ctx: PluginContext,
    containerId: string,
  ): Promise<string | undefined> {
    const cached = await ctx.storage.get(`container-project:${containerId}`);
    if (cached) return cached;

    const projects = await this.listProjects(ctx);
    for (const p of projects) {
      const fileAreas = await this.get<DaluxFileArea[]>(
        ctx,
        ENDPOINTS.fileAreas(p.id),
      );
      for (const fa of fileAreas) {
        if (fa.Id === containerId) {
          await ctx.storage.set(`container-project:${containerId}`, p.id);
          return p.id;
        }
      }
    }
    return undefined;
  }

  private async resolveFileLocation(
    ctx: PluginContext,
    fileId: string,
  ): Promise<{ projectId: string; fileAreaId: string } | undefined> {
    const cached = await ctx.storage.get(`file-loc:${fileId}`);
    if (cached) {
      const parsed = JSON.parse(cached) as { projectId: string; fileAreaId: string };
      return parsed;
    }

    const projects = await this.listProjects(ctx);
    for (const p of projects) {
      const fileAreas = await this.get<DaluxFileArea[]>(
        ctx,
        ENDPOINTS.fileAreas(p.id),
      );
      for (const fa of fileAreas) {
        const files = await this.get<DaluxFile[]>(
          ctx,
          ENDPOINTS.files(p.id, fa.Id),
        );
        if (files.some((f) => f.Id === fileId)) {
          const loc = { projectId: p.id, fileAreaId: fa.Id };
          await ctx.storage.set(`file-loc:${fileId}`, JSON.stringify(loc));
          return loc;
        }
      }
    }
    return undefined;
  }

  private async get<T>(ctx: PluginContext, url: string): Promise<T> {
    const res = await this.authedFetch(ctx, url);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Dalux API ${res.status}: ${res.statusText} — ${body}`);
    }
    return (await res.json()) as T;
  }

  private async authedFetch(ctx: PluginContext, url: string): Promise<Response> {
    const apiKey = await ctx.getPreference('apiKey');
    if (!apiKey) throw new Error('Dalux API key not configured');

    return ctx.fetch(url, {
      headers: {
        'X-API-Key': apiKey,
        Accept: 'application/json',
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

function toSourceFile(f: DaluxFile): SourceFile {
  const revisions: SourceRevision[] = (f.Revisions ?? []).map((r) => ({
    id: r.Id,
    version: r.Version,
    createdAt: r.CreatedAt,
    createdBy: r.CreatedBy,
    sizeBytes: r.Size,
  }));

  return {
    id: f.Id,
    name: f.Name,
    containerId: f.FileAreaId,
    mimeType: f.MimeType,
    sizeBytes: f.Size,
    currentRevisionId: f.CurrentRevision?.Id ?? revisions[0]?.id ?? '',
    revisions,
  };
}

function matchGlob(pattern: string, name: string): boolean {
  const re = new RegExp(
    '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$',
    'i',
  );
  return re.test(name);
}

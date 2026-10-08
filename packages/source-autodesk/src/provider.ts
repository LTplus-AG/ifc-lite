/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type {
  DownloadOptions, FileFilter, FileSourceProvider, ListOptions, ListProjectsOptions,
  Page, PluginContext, RevisionWatchResult, SourceContainer, SourceFile,
  SourceFileRef, SourceProject, SourceRevision,
} from '@ifc-lite/plugin-api';
import { AutodeskError, createApi, type AutodeskService } from './api.js';
import { AutodeskAuth } from './auth.js';
import { downloadFile, folders, getFile, listFiles, versions } from './files.js';
import { manifest } from './manifest.js';
import { listProjects } from './projects.js';
import { address, parseAddress } from './refs.js';
import { rememberedSites, rememberSite } from './remembered-sites.js';
import { proposals, proposalVersions } from './sites.js';

export interface AutodeskProviderOptions {
  /** Public application ID for static deployments. Never a client secret. */
  readonly clientId?: string;
  readonly service?: AutodeskService;
}
export class AutodeskProvider implements FileSourceProvider {
  readonly manifest;
  readonly auth: AutodeskAuth;
  constructor(private readonly options: AutodeskProviderOptions = {}) {
    this.manifest = manifest(options.clientId, Boolean(options.service));
    this.auth = new AutodeskAuth(options.service);
  }
  private api(ctx: PluginContext) { return createApi(ctx, () => this.auth.accessToken(ctx), this.options.service); }
  async listProjects(ctx: PluginContext, options?: ListProjectsOptions): Promise<Page<SourceProject>> {
    const page = await listProjects(this.api(ctx), options);
    const identity = await this.auth.getIdentity(ctx);
    if (!identity) return page;
    if (options?.query && page.items[0]) {
      if (parseAddress(page.items[0].id).kind === 'site') await rememberSite(ctx, identity.id, page.items[0]);
    } else if (!options?.cursor) {
      const sites = await rememberedSites(ctx, identity.id);
      return { ...page, items: [...sites, ...page.items] };
    }
    return page;
  }
  async listContainers(ctx: PluginContext, projectId: string, parentId?: string, options?: ListOptions): Promise<Page<SourceContainer>> {
    const project = parseAddress(projectId);
    if (project.kind === 'site') return { items: parentId ? [] : [{
      id: address({ ...project, kind: 'proposals' }), name: 'Forma Site Design proposals', hasChildren: false,
    }] };
    return folders(this.api(ctx), project, parentId ? parseAddress(parentId) : undefined, options);
  }
  listFiles(ctx: PluginContext, projectId: string, containerId: string, filter?: FileFilter, options?: ListOptions): Promise<Page<SourceFile>> {
    const project = parseAddress(projectId);
    if (project.kind === 'site') return proposals(this.api(ctx), project, containerId, options, this.options.service?.imports.includes('proposal'));
    return listFiles(this.api(ctx), project, containerId, filter, options, this.options.service?.imports.includes('exchange'));
  }
  async download(ctx: PluginContext, ref: SourceFileRef, options?: DownloadOptions): Promise<ArrayBuffer> {
    options?.signal?.throwIfAborted();
    const project = parseAddress(ref.projectId);
    const file = project.kind === 'site' ? undefined : await getFile(this.api(ctx), project, ref, Boolean(this.options.service?.imports.includes('exchange')), options?.signal);
    const kind = project.kind === 'site' ? 'proposal' : file?.kind === 'exchange' ? 'exchange' : 'file';
    if (kind !== 'file') {
      const service = this.options.service;
      if (!service?.imports.includes(kind)) throw new AutodeskError('import-unavailable', `Native ${kind} import requires a configured artifact adapter. See Autodesk source setup.`);
      if (!ref.revisionId) throw new AutodeskError('revision-required', 'Choose a source revision before importing.');
      options?.onPhase?.('preparing');
      return service.importResource(ref, project.region, options);
    }
    if (file?.unavailableReason) throw new AutodeskError('unsupported', file.unavailableReason);
    return downloadFile(this.api(ctx), project, ref, options);
  }
  async listRevisions(ctx: PluginContext, ref: SourceFileRef, options?: ListOptions): Promise<Page<SourceRevision>> {
    const project = parseAddress(ref.projectId);
    if (project.kind === 'site') {
      return proposalVersions(this.api(ctx), project, ref.fileId, options);
    }
    return versions(this.api(ctx), project, ref, options);
  }
  async watchRevisions(ctx: PluginContext, refs: readonly SourceFileRef[], _cursor?: string, options?: ListOptions): Promise<RevisionWatchResult> {
    if (refs.length > 200) throw new AutodeskError('watch-limit', 'Check no more than 200 Autodesk models at once.');
    const events: RevisionWatchResult['events'][number][] = [];
    for (const ref of refs) {
      const project = parseAddress(ref.projectId);
      if (project.kind === 'site') {
        let cursor: string | undefined;
        const seen = new Set<string>(); let found: SourceFile | undefined;
        do {
          if (seen.size >= 100 || (cursor && seen.has(cursor))) throw new AutodeskError('watch-limit', 'Forma proposal paging did not finish.');
          if (cursor) seen.add(cursor);
          const page = await proposals(this.api(ctx), project, ref.containerId, { ...options, cursor, limit: 100 });
          found = page.items.find((file) => file.id === ref.fileId); cursor = page.cursor;
        } while (!found && cursor);
        if (!found) events.push({ fileId: ref.fileId, latestRevisionId: ref.revisionId ?? '', deleted: true });
        else if (found.currentRevisionId !== ref.revisionId) events.push({ fileId: ref.fileId, latestRevisionId: found.currentRevisionId, previousRevisionId: ref.revisionId });
      } else {
        try {
          const latest = await getFile(this.api(ctx), project, { ...ref, revisionId: undefined }, false, options?.signal);
          if (latest.currentRevisionId !== ref.revisionId) events.push({ fileId: ref.fileId, latestRevisionId: latest.currentRevisionId, previousRevisionId: ref.revisionId });
        } catch (error) {
          if (error instanceof AutodeskError && error.status === 404) events.push({ fileId: ref.fileId, latestRevisionId: ref.revisionId ?? '', deleted: true });
          else throw error;
        }
      }
    }
    return { events };
  }
  async testConnection(ctx: PluginContext) {
    const identity = await this.auth.getIdentity(ctx);
    return { ok: Boolean(identity), message: identity ? 'Connected to Autodesk. Project access also requires account integration provisioning.' : 'Sign in with Autodesk.' };
  }
}

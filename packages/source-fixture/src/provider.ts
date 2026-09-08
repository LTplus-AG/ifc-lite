/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type {
  ConnectionTestResult,
  DownloadOptions,
  FileFilter,
  FileSourceProvider,
  ListOptions,
  ListProjectsOptions,
  Page,
  PluginAuthKind,
  PluginContext,
  ProviderCapabilities,
  RelayDeclaration,
  RevisionEvent,
  RevisionWatchResult,
  SourceContainer,
  SourceFile,
  SourceFileRef,
  SourceIdentity,
  SourceProject,
  SourceRevision,
} from '@ifc-lite/plugin-api';

import { createFixtureAuth, DEFAULT_FIXTURE_IDENTITY, requireSignedIn } from './auth.js';
import { FixtureWorld, type FixtureWorldSpec } from './data.js';
import { FixtureApiError, toAbortError } from './errors.js';
import { applyBlockingFailure, applyTruncate, type FixtureMethodName, type InjectedFailure } from './failures.js';
import { buildFixtureManifest } from './manifest.js';
import { applyFileFilter, serializeFilter, toSourceContainer, toSourceFile, toSourceProject, toSourceRevision } from './mapping.js';
import { paginate } from './paging.js';

export interface FixtureCapabilityOptions {
  /** Default `true` — controls whether `listRevisions` is present. */
  readonly revisionHistory?: boolean;
  readonly downloadHistoricalRevisions?: boolean;
  /** Default `true` — controls whether `watchRevisions` is present. */
  readonly changeDetection?: boolean;
  /** Default `true` — controls whether `searchFiles` is present. */
  readonly search?: boolean;
  readonly projectsAreDiscoverableOnly?: boolean;
}

export interface FixtureManifestOverrides {
  readonly name?: string;
  readonly title?: string;
  readonly apiRange?: string;
  readonly network?: readonly string[];
  readonly relay?: RelayDeclaration;
}

export interface FixtureProviderOptions {
  readonly world: FixtureWorldSpec;
  /** Default `'direct-children'`. */
  readonly containerListing?: 'direct-children' | 'flat-subtree';
  /** Default `false`. */
  readonly listFilesIsRecursive?: boolean;
  /** Default `false`. */
  readonly eagerFileSweep?: boolean;
  /** Server-side page size cap, matching a real provider's own clamp. Default `25`. */
  readonly pageSize?: number;
  /** Default `'preferences'`. */
  readonly auth?: PluginAuthKind;
  /** Identity `signIn` produces when `auth: 'interactive'`. Defaults to a canned identity. */
  readonly identity?: SourceIdentity;
  readonly capabilities?: FixtureCapabilityOptions;
  readonly manifest?: FixtureManifestOverrides;
  /** Failures to inject from construction. Adjustable afterwards via `.fixture.setFailure`. */
  readonly failures?: Partial<Record<FixtureMethodName, InjectedFailure>>;
}

export interface FixtureController {
  /** Sets, replaces, or (passing `undefined`) clears the injected failure for one method. */
  setFailure(method: FixtureMethodName, failure: InjectedFailure | undefined): void;
}

/** The fixture provider: a conformant `FileSourceProvider` plus test controls under `.fixture`. */
export type FixtureSourceProvider = FileSourceProvider & { readonly fixture: FixtureController };

function contextKeyFor(method: FixtureMethodName, ...parts: string[]): string {
  return `${method}:${parts.join(':')}`;
}

/** Builds an in-memory, network-free `FileSourceProvider` over a declarative {@link FixtureWorldSpec}. */
export function createFixtureSourceProvider(options: FixtureProviderOptions): FixtureSourceProvider {
  const world = new FixtureWorld(options.world);
  const maxPageSize = options.pageSize ?? 25;
  const authKind: PluginAuthKind = options.auth ?? 'preferences';

  const capabilities: ProviderCapabilities = {
    containerListing: options.containerListing ?? 'direct-children',
    listFilesIsRecursive: options.listFilesIsRecursive ?? false,
    revisionHistory: options.capabilities?.revisionHistory ?? true,
    downloadHistoricalRevisions: options.capabilities?.downloadHistoricalRevisions ?? true,
    changeDetection: options.capabilities?.changeDetection ?? true,
    search: options.capabilities?.search ?? true,
    ...(options.capabilities?.projectsAreDiscoverableOnly !== undefined
      ? { projectsAreDiscoverableOnly: options.capabilities.projectsAreDiscoverableOnly }
      : {}),
    ...(options.eagerFileSweep !== undefined ? { eagerFileSweep: options.eagerFileSweep } : {}),
  };

  const manifest = buildFixtureManifest({
    name: options.manifest?.name,
    title: options.manifest?.title,
    apiRange: options.manifest?.apiRange,
    network: options.manifest?.network,
    relay: options.manifest?.relay,
    auth: authKind,
    capabilities,
  });

  const failureMap = new Map<FixtureMethodName, InjectedFailure>(
    Object.entries(options.failures ?? {}) as Array<[FixtureMethodName, InjectedFailure]>,
  );

  const auth = authKind === 'interactive' ? createFixtureAuth(options.identity ?? DEFAULT_FIXTURE_IDENTITY) : undefined;

  /**
   * Abort check, sign-in gate, and failure injection, shared by every
   * method. An already-aborted signal rejects immediately regardless of any
   * injected failure — matching a real fetch-backed provider, whose host
   * fetch wrapper honors `AbortSignal` on every call, not only ones that
   * happen to be slow.
   */
  async function guard(method: FixtureMethodName, ctx: PluginContext, signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted) throw toAbortError(signal);
    await requireSignedIn(ctx, auth);
    await applyBlockingFailure(failureMap.get(method), signal);
  }

  async function listProjects(ctx: PluginContext, listOptions?: ListProjectsOptions): Promise<Page<SourceProject>> {
    await guard('listProjects', ctx, listOptions?.signal);
    const all = world.listProjects();
    const query = listOptions?.query;
    const filtered = query ? all.filter((p) => p.name.toLowerCase().includes(query.toLowerCase())) : all;
    const page = paginate(filtered.map(toSourceProject), contextKeyFor('listProjects', query ?? ''), listOptions, maxPageSize);
    return applyTruncate(page, failureMap.get('listProjects'));
  }

  async function listContainers(
    ctx: PluginContext,
    projectId: string,
    parentId?: string,
    listOptions?: ListOptions,
  ): Promise<Page<SourceContainer>> {
    await guard('listContainers', ctx, listOptions?.signal);
    const containers =
      capabilities.containerListing === 'flat-subtree'
        ? world.subtreeDescendants(projectId, parentId)
        : world.directChildren(projectId, parentId);
    const page = paginate(
      containers.map((c) => toSourceContainer(c, world)),
      contextKeyFor('listContainers', projectId, parentId ?? ''),
      listOptions,
      maxPageSize,
    );
    return applyTruncate(page, failureMap.get('listContainers'));
  }

  async function listFiles(
    ctx: PluginContext,
    projectId: string,
    containerId: string,
    filter?: FileFilter,
    listOptions?: ListOptions,
  ): Promise<Page<SourceFile>> {
    await guard('listFiles', ctx, listOptions?.signal);
    const files = applyFileFilter(world.filesInContainer(projectId, containerId, capabilities.listFilesIsRecursive), filter);
    const page = paginate(
      files.map(toSourceFile),
      contextKeyFor('listFiles', projectId, containerId, serializeFilter(filter)),
      listOptions,
      maxPageSize,
    );
    return applyTruncate(page, failureMap.get('listFiles'));
  }

  async function download(ctx: PluginContext, ref: SourceFileRef, downloadOptions?: DownloadOptions): Promise<ArrayBuffer> {
    await guard('download', ctx, downloadOptions?.signal);
    const file = world.getFile(ref.projectId, ref.containerId, ref.fileId);
    // Honour the declared capability. The fixture is the oracle the conformance
    // suites run against, so serving a historical revision while
    // `downloadHistoricalRevisions` is false would make it impossible to catch
    // a real provider that ignores its own manifest.
    if (ref.revisionId && !manifest.capabilities.downloadHistoricalRevisions) {
      throw new Error(
        `fixture provider "${manifest.name}" declares downloadHistoricalRevisions: false, ` +
        `so download() must not accept ref.revisionId ("${ref.revisionId}")`,
      );
    }
    const revision = ref.revisionId ? world.getRevision(file, ref.revisionId) : world.currentRevision(file);
    downloadOptions?.onProgress?.(revision.content.byteLength, revision.content.byteLength);
    const bytes = revision.content;
    // Slice to a fresh ArrayBuffer: callers must not observe the fixture's
    // internal Uint8Array (and its buffer may be larger than the view).
    return bytes.slice().buffer;
  }

  async function listRevisions(ctx: PluginContext, ref: SourceFileRef, listOptions?: ListOptions): Promise<Page<SourceRevision>> {
    await guard('listRevisions', ctx, listOptions?.signal);
    const file = world.getFile(ref.projectId, ref.containerId, ref.fileId);
    const page = paginate(
      file.revisions.map(toSourceRevision),
      contextKeyFor('listRevisions', ref.projectId, ref.containerId, ref.fileId),
      listOptions,
      maxPageSize,
    );
    return applyTruncate(page, failureMap.get('listRevisions'));
  }

  async function watchRevisions(
    ctx: PluginContext,
    refs: readonly SourceFileRef[],
    _cursor?: string,
    listOptions?: ListOptions,
  ): Promise<RevisionWatchResult> {
    await guard('watchRevisions', ctx, listOptions?.signal);
    const events: RevisionEvent[] = [];
    for (const ref of refs) {
      const file = world.tryGetFile(ref.projectId, ref.fileId);
      if (!file) {
        events.push({ fileId: ref.fileId, latestRevisionId: ref.revisionId ?? '', deleted: true });
        continue;
      }
      const latest = world.currentRevision(file).id;
      if (ref.revisionId !== undefined && ref.revisionId !== latest) {
        events.push({ fileId: ref.fileId, latestRevisionId: latest, previousRevisionId: ref.revisionId });
      }
    }
    // A static fixture has nothing to delta beyond the given refs, but a
    // cursor is still returned unconditionally so hosts that persist and
    // pass it back are exercised the same as against a real delta feed.
    return { events, cursor: `watch.${refs.length}` };
  }

  async function searchFiles(
    ctx: PluginContext,
    projectId: string,
    query: string,
    filter?: FileFilter,
    listOptions?: ListOptions,
  ): Promise<Page<SourceFile>> {
    await guard('searchFiles', ctx, listOptions?.signal);
    const files = applyFileFilter(world.searchFiles(projectId, query), filter);
    const page = paginate(
      files.map(toSourceFile),
      contextKeyFor('searchFiles', projectId, query, serializeFilter(filter)),
      listOptions,
      maxPageSize,
    );
    return applyTruncate(page, failureMap.get('searchFiles'));
  }

  async function testConnection(ctx: PluginContext): Promise<ConnectionTestResult> {
    try {
      await guard('testConnection', ctx, undefined);
      const projectCount = world.listProjects().length;
      return { ok: true, message: `Connected — ${projectCount} project(s) accessible.`, projectCount };
    } catch (err) {
      if (err instanceof FixtureApiError) return { ok: false, message: err.message };
      throw err;
    }
  }

  const provider: FileSourceProvider = {
    manifest,
    ...(auth ? { auth } : {}),
    listProjects,
    listContainers,
    listFiles,
    download,
    ...(capabilities.revisionHistory ? { listRevisions } : {}),
    ...(capabilities.changeDetection ? { watchRevisions } : {}),
    ...(capabilities.search ? { searchFiles } : {}),
    testConnection,
  };

  const fixture: FixtureController = {
    setFailure(method, failure) {
      if (failure) failureMap.set(method, failure);
      else failureMap.delete(method);
    },
  };

  return Object.assign(provider, { fixture });
}

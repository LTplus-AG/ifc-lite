/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type {
  CommitCapabilities,
  CommitFingerprintSet,
  CommitPayload,
  CommitRef,
  CommitWatchResult,
  ConnectionTestResult,
  CreateCommitInput,
  CreateModelInput,
  ElementHistoryEntry,
  ElementHistoryQuery,
  FileSourceProvider,
  GetCommitDiffOptions,
  IdentityEntryLike,
  IdentityRecordSet,
  ListCommitsOptions,
  ListModelsOptions,
  ListOptions,
  ListProjectsOptions,
  LoadCommitOptions,
  LoadFingerprintsOptions,
  ModelRef,
  Page,
  PluginContext,
  PluginManifest,
  SourceCommit,
  SourceContainer,
  SourceFile,
  SourceModel,
  SourceProject,
  StoredCommitDiff,
} from '@ifc-lite/plugin-api';

import { accessTokenFor, commitHttpAuth, resolveConfig } from './auth.js';
import { CommitHttpError } from './errors.js';
import { CommitHttpClient, MEDIA_TYPES, formatForMediaType } from './http-client.js';
import { buildCommitHttpManifest, type CommitHttpManifestOptions } from './manifest.js';
import { decodeCapabilities, decodeCommit, decodeModel, decodePage } from './wire.js';

const EMPTY_PAGE = { items: [] } as const;

/** Human-readable list of the flags on which a declaration and a live document disagree. */
function capabilityDrift(declared: CommitCapabilities, live: CommitCapabilities): string[] {
  const flags = ['fingerprints', 'storedDiffs', 'elementHistory', 'identityRecords', 'write', 'watch'] as const;
  const drift = flags
    .filter((flag) => declared[flag] !== live[flag])
    .map((flag) => `${flag} declared ${declared[flag]}, service reports ${live[flag]}`);
  const missing = live.payloadFormats.filter((format) => !declared.payloadFormats.includes(format));
  const extra = declared.payloadFormats.filter((format) => !live.payloadFormats.includes(format));
  if (missing.length > 0) drift.push(`service also serves ${missing.join(', ')}`);
  if (extra.length > 0) drift.push(`service does not serve ${extra.join(', ')}`);
  return drift;
}

export interface CommitHttpProviderOptions extends CommitHttpManifestOptions {}

/**
 * Reads `GET /capabilities` without a provider, so a deployment can discover
 * what its service supports at bootstrap and hand the result to
 * {@link createCommitHttpProvider}.
 *
 * `fetch` is the caller's, not a `PluginContext`'s: this runs BEFORE
 * registration, so there is no context yet, and the caller is the host
 * application rather than sandboxed plugin code. Unauthenticated, because a
 * capability document is not user data — a service that gates it should be
 * declared statically instead.
 */
export async function fetchCommitCapabilities(
  baseUrl: string,
  doFetch: typeof fetch = fetch,
): Promise<CommitCapabilities> {
  const url = `${baseUrl.replace(/\/+$/, '')}/capabilities`;
  const response = await doFetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    throw new CommitHttpError('unavailable', `Commit service capabilities: ${url} responded ${response.status}`, response.status);
  }
  return decodeCapabilities(await response.json());
}

/**
 * A commit-aware provider over the REST contract in this package's README.
 *
 * A FACTORY rather than a singleton, because `permissions.network` is a
 * build-time security declaration and this provider's host is per-deployment
 * — see {@link CommitHttpManifestOptions} for why that cannot be a user
 * preference.
 */
export function createCommitHttpProvider(options: CommitHttpProviderOptions): FileSourceProvider {
  const manifest: PluginManifest = buildCommitHttpManifest(options);

  async function client(ctx: PluginContext): Promise<{ http: CommitHttpClient; baseUrl: string }> {
    const config = await resolveConfig(ctx);
    return {
      baseUrl: config.baseUrl,
      http: new CommitHttpClient(config.baseUrl, ctx, () => accessTokenFor(ctx, config)),
    };
  }

  const declared: CommitCapabilities = options.commits;

  async function listProjects(ctx: PluginContext, listOptions?: ListProjectsOptions): Promise<Page<SourceProject>> {
    const { http } = await client(ctx);
    return http.json<unknown>('/projects', {
      query: { cursor: listOptions?.cursor, limit: listOptions?.limit, query: listOptions?.query },
      ...(listOptions?.signal ? { signal: listOptions.signal } : {}),
    }).then((body) =>
      decodePage(body, 'project', (item) => {
        const project = item as Record<string, unknown>;
        return {
          id: String(project.id ?? ''),
          name: String(project.name ?? ''),
          ...(typeof project.description === 'string' ? { description: project.description } : {}),
        } satisfies SourceProject;
      }),
    );
  }

  // A commit service is not a file store. Both are required by the 2.0.0
  // contract and both answer empty rather than throwing, so a host browsing
  // this provider sees "nothing here" instead of an error it cannot act on.
  async function listContainers(): Promise<Page<SourceContainer>> {
    return EMPTY_PAGE;
  }
  async function listFiles(): Promise<Page<SourceFile>> {
    return EMPTY_PAGE;
  }
  async function download(): Promise<ArrayBuffer> {
    throw new CommitHttpError(
      'unsupported-format',
      'This is a commit service: load a commit with loadCommit() rather than downloading a file.',
      0,
    );
  }

  async function listModels(ctx: PluginContext, projectId: string, listOptions?: ListModelsOptions): Promise<Page<SourceModel>> {
    const { http } = await client(ctx);
    const body = await http.json<unknown>(`/projects/${encodeURIComponent(projectId)}/models`, {
      query: { cursor: listOptions?.cursor, limit: listOptions?.limit, query: listOptions?.query },
      ...(listOptions?.signal ? { signal: listOptions.signal } : {}),
    });
    return decodePage(body, 'model', decodeModel);
  }

  function modelPath(ref: ModelRef): string {
    return `/projects/${encodeURIComponent(ref.projectId)}/models/${encodeURIComponent(ref.modelId)}`;
  }

  async function getModel(ctx: PluginContext, ref: ModelRef): Promise<SourceModel> {
    const { http } = await client(ctx);
    return decodeModel(await http.json<unknown>(modelPath(ref)));
  }

  async function listCommits(ctx: PluginContext, ref: ModelRef, listOptions?: ListCommitsOptions): Promise<Page<SourceCommit>> {
    const { http } = await client(ctx);
    const body = await http.json<unknown>(`${modelPath(ref)}/commits`, {
      query: {
        cursor: listOptions?.cursor,
        limit: listOptions?.limit,
        before: listOptions?.before,
        after: listOptions?.after,
        includeUnpublished: listOptions?.includeUnpublished,
      },
      ...(listOptions?.signal ? { signal: listOptions.signal } : {}),
    });
    return decodePage(body, 'commit', decodeCommit);
  }

  function commitPath(ref: CommitRef): string {
    return `${modelPath(ref)}/commits/${encodeURIComponent(ref.commitId)}`;
  }

  async function getCommit(ctx: PluginContext, ref: CommitRef): Promise<SourceCommit> {
    const { http } = await client(ctx);
    return decodeCommit(await http.json<unknown>(commitPath(ref)));
  }

  async function loadCommit(ctx: PluginContext, ref: CommitRef, loadOptions?: LoadCommitOptions): Promise<CommitPayload> {
    const { http } = await client(ctx);
    const accept = loadOptions?.accept ?? declared.payloadFormats;
    // Resolved client-side as well as sent as an `Accept` header: a service
    // that ignores content negotiation and returns its own favourite format
    // would otherwise have its choice silently relabelled as the host's.
    const wanted = accept.filter((format) => declared.payloadFormats.includes(format));
    if (wanted.length === 0) {
      throw new CommitHttpError(
        'unsupported-format',
        `Commit service serves ${declared.payloadFormats.join(', ')}; none are acceptable to this host`,
        415,
      );
    }

    const response = await http.raw(`${commitPath(ref)}/payload`, {
      headers: { Accept: wanted.map((format) => MEDIA_TYPES[format]).join(', ') },
      ...(loadOptions?.signal ? { signal: loadOptions.signal } : {}),
    });
    const format = formatForMediaType(response.headers.get('Content-Type')) ?? wanted[0];
    if (!wanted.includes(format)) {
      throw new CommitHttpError('unsupported-format', `Commit service returned ${format}, which this host did not accept`, 415);
    }

    const bytes = await response.arrayBuffer();
    loadOptions?.onProgress?.(bytes.byteLength, bytes.byteLength);
    const digest = response.headers.get('X-Artifact-Digest');
    return {
      format,
      fileName: response.headers.get('X-Artifact-Filename') ?? `${ref.commitId}.ifc`,
      bytes,
      // Falls back to the commit's own record when the service did not stamp
      // the header, so the host's digest check still has something real to
      // compare the bytes against.
      artifactDigest: digest ?? (await getCommit(ctx, ref)).artifact.digest,
    };
  }

  async function loadCommitFingerprints(
    ctx: PluginContext,
    ref: CommitRef,
    fingerprintOptions?: LoadFingerprintsOptions,
  ): Promise<CommitFingerprintSet> {
    const { http } = await client(ctx);
    return http.json<CommitFingerprintSet>(`${commitPath(ref)}/fingerprints`, {
      query: {
        keyProperty: fingerprintOptions?.keyProperty,
        maxEntries: fingerprintOptions?.maxEntries,
        dataOnly: fingerprintOptions?.dataOnly,
      },
      ...(fingerprintOptions?.signal ? { signal: fingerprintOptions.signal } : {}),
    });
  }

  async function getCommitDiff(
    ctx: PluginContext,
    base: CommitRef,
    head: CommitRef,
    diffOptions?: GetCommitDiffOptions,
  ): Promise<StoredCommitDiff> {
    const { http } = await client(ctx);
    return http.json<StoredCommitDiff>(`${modelPath(head)}/diff`, {
      query: { base: base.commitId, head: head.commitId, keyProperty: diffOptions?.keyProperty },
      ...(diffOptions?.signal ? { signal: diffOptions.signal } : {}),
    });
  }

  async function listElementHistory(
    ctx: PluginContext,
    query: ElementHistoryQuery,
    listOptions?: ListOptions,
  ): Promise<Page<ElementHistoryEntry>> {
    const { http } = await client(ctx);
    const body = await http.json<unknown>(
      `${modelPath(query)}/elements/${encodeURIComponent(query.key)}/history`,
      {
        query: {
          atCommitId: query.atCommitId,
          keyProperty: query.keyProperty,
          cursor: listOptions?.cursor,
          limit: listOptions?.limit,
        },
        ...(listOptions?.signal ? { signal: listOptions.signal } : {}),
      },
    );
    return decodePage(body, 'element history', (item) => item as ElementHistoryEntry);
  }

  async function listIdentityRecords(ctx: PluginContext, base: CommitRef, head: CommitRef): Promise<IdentityRecordSet> {
    const { http } = await client(ctx);
    return http.json<IdentityRecordSet>(`${modelPath(head)}/identity`, {
      query: { base: base.commitId, head: head.commitId },
    });
  }

  async function createModel(ctx: PluginContext, input: CreateModelInput): Promise<SourceModel> {
    const { http } = await client(ctx);
    return decodeModel(
      await http.json<unknown>(`/projects/${encodeURIComponent(input.projectId)}/models`, {
        method: 'POST',
        body: { name: input.name, containerId: input.containerId, discipline: input.discipline, meta: input.meta },
      }),
    );
  }

  async function createCommit(ctx: PluginContext, input: CreateCommitInput): Promise<SourceCommit> {
    const { http } = await client(ctx);
    // Multipart, per the REST contract: a `meta` JSON part and a `file` part.
    // A base64 body would inflate an IFC by a third for no benefit.
    const form = new FormData();
    form.append(
      'meta',
      new Blob([JSON.stringify({
        expectedParentId: input.expectedParentId,
        message: input.message,
        resolution: input.resolution,
        identity: input.identity,
      })], { type: 'application/json' }),
    );
    form.append('file', new Blob([input.bytes], { type: MEDIA_TYPES['ifc-step'] }), input.fileName);
    input.onProgress?.(0, input.bytes.byteLength);

    const commit = decodeCommit(
      await http.json<unknown>(`${modelPath({ projectId: input.projectId, modelId: input.modelId })}/commits`, {
        method: 'POST',
        headers: { 'Idempotency-Key': input.idempotencyKey },
        body: form,
        ...(input.signal ? { signal: input.signal } : {}),
      }),
    );
    input.onProgress?.(input.bytes.byteLength, input.bytes.byteLength);
    return commit;
  }

  async function recordIdentity(
    ctx: PluginContext,
    base: CommitRef,
    head: CommitRef,
    entries: readonly IdentityEntryLike[],
  ): Promise<IdentityRecordSet> {
    const { http } = await client(ctx);
    return http.json<IdentityRecordSet>(`${modelPath(head)}/identity`, {
      method: 'POST',
      query: { base: base.commitId, head: head.commitId },
      body: { entries },
    });
  }

  async function watchCommits(
    ctx: PluginContext,
    models: readonly ModelRef[],
    cursor?: string,
    listOptions?: ListOptions,
  ): Promise<CommitWatchResult> {
    const { http } = await client(ctx);
    const projectId = models[0]?.projectId;
    if (projectId === undefined) return { events: [] };
    return http.json<CommitWatchResult>(`/projects/${encodeURIComponent(projectId)}/commit-events`, {
      method: 'POST',
      body: { modelIds: models.map((model) => model.modelId), cursor },
      ...(listOptions?.signal ? { signal: listOptions.signal } : {}),
    });
  }

  async function testConnection(ctx: PluginContext): Promise<ConnectionTestResult> {
    try {
      const { http } = await client(ctx);
      const live = decodeCapabilities(await http.json<unknown>('/capabilities'));
      const projects = await listProjects(ctx, { limit: 1 });
      // A declaration that has drifted from the service is the failure mode
      // this design trades for: the manifest is fixed at registration, so
      // nothing else would ever notice. Reported as a successful connection
      // with a warning, because the connection genuinely works.
      const drift = capabilityDrift(declared, live);
      return {
        ok: true,
        message: drift.length === 0
          ? `Connected — commit API available (${live.payloadFormats.join(', ')}).`
          : `Connected, but this viewer's declared capabilities disagree with the service: ${drift.join(', ')}. Re-register the provider with the service's own /capabilities.`,
        ...(projects.cursor === undefined ? { projectCount: projects.items.length } : {}),
      };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  return {
    manifest,
    auth: commitHttpAuth,
    listProjects,
    listContainers,
    listFiles,
    download,
    testConnection,
    listModels,
    getModel,
    listCommits,
    getCommit,
    loadCommit,
    // Present exactly when the declared flag says so — the invariant
    // `runCommitConformanceSuite` checks first, and the reason `commits` is a
    // required registration input rather than something discovered lazily.
    ...(declared.fingerprints ? { loadCommitFingerprints } : {}),
    ...(declared.storedDiffs ? { getCommitDiff } : {}),
    ...(declared.elementHistory ? { listElementHistory } : {}),
    ...(declared.identityRecords ? { listIdentityRecords } : {}),
    ...(declared.write ? { createModel, createCommit, recordIdentity } : {}),
    ...(declared.watch ? { watchCommits } : {}),
  };
}

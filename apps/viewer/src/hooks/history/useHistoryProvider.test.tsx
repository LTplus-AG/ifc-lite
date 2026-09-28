/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which history a loaded model gets, and from where.
 *
 * The case worth pinning is the one that is easy to get wrong and invisible
 * when it is: a model opened through the ORDINARY file browser has a
 * `SourceTag` and no commit tag, and for a provider whose model ids are file
 * ids that is still enough to find its history. Without that branch the
 * History panel sits empty for a model whose history the provider can serve
 * — which is every Dalux model a user opens the normal way.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FileSourceProvider, PluginManifest, ProviderCapabilities } from '@ifc-lite/plugin-api';
import { PLUGIN_API_VERSION } from '@ifc-lite/plugin-api';

import { cleanup, render } from '@/test/render.js';
import { SourceHostProvider } from '@/services/sources/SourceHostProvider';
import { useViewerStore } from '@/store';
import type { CommitTag } from '@/store/slices/historySlice';
import { useHistoryProvider, type ResolvedHistorySource } from './useHistoryProvider';

const VIEWER_MODEL = 'viewer-model-1';

function makeProvider(options: {
  readonly name: string;
  readonly commits?: Partial<ProviderCapabilities['commits']> | null;
  readonly revisionHistory?: boolean;
}): FileSourceProvider {
  const commits = options.commits === null || options.commits === undefined
    ? undefined
    : {
        payloadFormats: ['ifc-step' as const],
        fingerprints: false,
        storedDiffs: false,
        elementHistory: false,
        identityRecords: false,
        write: false,
        watch: false,
        modelIdsAreFileIds: false,
        ...options.commits,
      };
  const manifest: PluginManifest = {
    name: options.name,
    title: options.name,
    api: `^${PLUGIN_API_VERSION}`,
    auth: 'preferences',
    permissions: { network: ['store.invalid'] },
    preferences: [],
    capabilities: {
      containerListing: 'direct-children',
      listFilesIsRecursive: false,
      revisionHistory: options.revisionHistory ?? false,
      downloadHistoricalRevisions: true,
      changeDetection: false,
      search: false,
      ...(commits ? { commits } : {}),
    },
    contributes: { fileSources: [] },
  };
  return {
    manifest,
    listProjects: async () => ({ items: [] }),
    listContainers: async () => ({ items: [] }),
    listFiles: async () => ({ items: [] }),
    download: async () => new ArrayBuffer(0),
    ...(commits
      ? {
          listModels: async () => ({ items: [] }),
          getModel: async () => {
            throw new Error('unused');
          },
          listCommits: async () => ({ items: [] }),
          getCommit: async () => {
            throw new Error('unused');
          },
          loadCommit: async () => {
            throw new Error('unused');
          },
        }
      : {}),
    ...(options.revisionHistory ? { listRevisions: async () => ({ items: [] }) } : {}),
  };
}

function commitTag(): CommitTag {
  return {
    provider: 'store',
    projectId: 'proj-1',
    sourceModelId: 'model-structural',
    commitId: 'c2',
    artifactDigest: 'x:1',
    historical: false,
    loadedAt: 1,
  };
}

function resolveWith(
  provider: FileSourceProvider,
  tags: { readonly commit?: CommitTag; readonly source?: boolean },
): ResolvedHistorySource | null {
  useViewerStore.setState({
    commitTags: tags.commit ? new Map([[VIEWER_MODEL, tags.commit]]) : new Map(),
    sourceTags: tags.source
      ? new Map([[VIEWER_MODEL, {
          provider: provider.manifest.name,
          projectId: 'proj-1',
          containerId: 'fa-models',
          fileId: 'file-structural',
          revisionId: 'rev-3',
          loadedAt: 1,
        }]])
      : new Map(),
  } as never);

  let captured: ResolvedHistorySource | null = null;
  function Probe() {
    captured = useHistoryProvider(VIEWER_MODEL);
    return null;
  }
  render(
    <SourceHostProvider additionalProviders={[() => provider]}>
      <Probe />
    </SourceHostProvider>,
  );
  return captured;
}

describe('useHistoryProvider', () => {
  afterEach(cleanup);

  it('uses the commit tag when the model was opened as a commit', () => {
    const provider = makeProvider({ name: 'store', commits: {} });
    const resolved = resolveWith(provider, { commit: commitTag() });
    assert.equal(resolved?.kind, 'commit');
    assert.equal(resolved?.sourceModelId, 'model-structural');
  });

  it('resolves a FILE-opened model when the provider says model ids are file ids', () => {
    const provider = makeProvider({ name: 'store', commits: { modelIdsAreFileIds: true } });
    const resolved = resolveWith(provider, { source: true });
    assert.equal(resolved?.kind, 'commit', 'a Dalux model opened from the file browser still has a history');
    // The FILE id is the model id — that is the whole content of the flag.
    assert.equal(resolved?.sourceModelId, 'file-structural');
    assert.equal(resolved?.commitTag, undefined);
  });

  it('does NOT invent a model id when the provider has not promised one', () => {
    // A commit service whose model ids are its own: guessing that the file id
    // is a model id would produce a `not-found` on every panel open.
    const provider = makeProvider({ name: 'store', commits: { modelIdsAreFileIds: false }, revisionHistory: true });
    const resolved = resolveWith(provider, { source: true });
    assert.equal(resolved?.kind, 'revision');
  });

  it('falls back to the revision adapter for a provider with no commit API', () => {
    const provider = makeProvider({ name: 'store', commits: null, revisionHistory: true });
    const resolved = resolveWith(provider, { source: true });
    assert.equal(resolved?.kind, 'revision');
    assert.equal(resolved?.sourceModelId, 'file-structural');
  });

  it('reports no history for a provider with neither', () => {
    const provider = makeProvider({ name: 'store', commits: null, revisionHistory: false });
    assert.equal(resolveWith(provider, { source: true })?.kind, 'none');
  });

  it('reports nothing at all for a model with no source', () => {
    const provider = makeProvider({ name: 'store', commits: {} });
    assert.equal(resolveWith(provider, {}), null);
  });
});

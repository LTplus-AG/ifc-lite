/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Resolving a viewer model id to "whose history is this, and of what kind".
 *
 * Shared by every history hook, because all of them need the same three
 * answers and getting them inconsistently is how a panel ends up showing a
 * commit-aware timeline while the card beside it says the source has no
 * element history.
 */

import { useCallback, useMemo } from 'react';
import type { FileSourceProvider, PluginContext, SourceTag } from '@ifc-lite/plugin-api';

import { useOptionalSourceHost } from '@/services/sources/SourceHostProvider';
import type { SourceHost } from '@/services/sources/source-host';
import { loadResolvedSourcePrefs } from '@/lib/sources/preferences';
import { useViewerStore } from '@/store';
import type { CommitTag } from '@/store/slices/historySlice';

/**
 * How much history a model can show.
 *
 * `commit` — the provider declares `capabilities.commits`.
 * `revision` — no commit API, but `listRevisions` works; the
 *   `revisionsAsCommits` adapter supplies a linear chain.
 * `none` — the model came from a file the user opened locally, or from a
 *   provider with neither. The panel says so rather than showing an empty list.
 */
export type HistoryKind = 'commit' | 'revision' | 'none';

export interface ResolvedHistorySource {
  readonly kind: HistoryKind;
  readonly provider: FileSourceProvider;
  readonly createContext: () => PluginContext;
  /** Present once the model has been opened as a commit. */
  readonly commitTag?: CommitTag;
  /** Present for a model loaded from a file source. */
  readonly sourceTag?: SourceTag;
  /** Provider-side model id for `commit`; the source FILE id for `revision`. */
  readonly sourceModelId: string;
  readonly projectId: string;
}

function resolve(
  host: SourceHost | null,
  commitTag: CommitTag | undefined,
  sourceTag: SourceTag | undefined,
): ResolvedHistorySource | null {
  if (!host) return null;
  const providerName = commitTag?.provider ?? sourceTag?.provider;
  if (!providerName) return null;
  const provider = host.get(providerName);
  if (!provider) return null;

  const createContext = () => host.createContext(provider.manifest, loadResolvedSourcePrefs(provider.manifest));
  const isCommitAware = provider.manifest.capabilities.commits !== undefined;

  if (isCommitAware && commitTag) {
    return {
      kind: 'commit',
      provider,
      createContext,
      commitTag,
      ...(sourceTag ? { sourceTag } : {}),
      sourceModelId: commitTag.sourceModelId,
      projectId: commitTag.projectId,
    };
  }
  if (!sourceTag) return null;

  // A commit-aware provider whose model ids ARE file ids can answer for a
  // model opened through the ordinary file browser, which is how most
  // models arrive — the user picks `structural.ifc`, not a commit. Without
  // this the History panel would sit empty for a model whose history the
  // provider can serve perfectly well, because the only thing missing is
  // the mapping from "this file" to "this model" that the capability
  // supplies. Dalux is the case: its commits are file revisions found
  // through version sets, and the file id is the model id.
  if (isCommitAware && provider.manifest.capabilities.commits?.modelIdsAreFileIds === true) {
    return {
      kind: 'commit',
      provider,
      createContext,
      sourceTag,
      sourceModelId: sourceTag.fileId,
      projectId: sourceTag.projectId,
    };
  }
  return {
    // A commit-aware provider whose model was loaded as a FILE (the sources
    // browser, not the history panel) has no commit tag yet. It still has
    // revisions, so it degrades to the adapter rather than to "no history" —
    // and gets the real timeline as soon as a commit is opened.
    kind: provider.manifest.capabilities.revisionHistory ? 'revision' : 'none',
    provider,
    createContext,
    ...(commitTag ? { commitTag } : {}),
    sourceTag,
    sourceModelId: sourceTag.fileId,
    projectId: sourceTag.projectId,
  };
}

/**
 * `null` when the model has no source at all — the panel's "not available"
 * state.
 *
 * MEMOIZED, and that is load-bearing rather than an optimisation: `resolve`
 * builds a fresh object (including a fresh `createContext` closure) on every
 * call, so an unmemoized return value would change identity on every render.
 * `useModelHistory`'s fetch callback depends on it, and its effect depends on
 * that callback — an unstable identity there is an infinite fetch loop, which
 * is exactly what it was before this `useMemo` (caught by
 * `HistoryPanel.test.tsx`'s Retry case hanging for two minutes).
 */
export function useHistoryProvider(modelId: string | null): ResolvedHistorySource | null {
  const host = useOptionalSourceHost();
  const commitTag = useViewerStore((s) => (modelId ? s.commitTags.get(modelId) : undefined));
  const sourceTag = useViewerStore((s) => (modelId ? s.sourceTags.get(modelId) : undefined));
  // The tags are immutable records replaced wholesale by their setters, so
  // reference equality on them is the right dependency.
  return useMemo(
    () => (modelId ? resolve(host, commitTag, sourceTag) : null),
    [modelId, host, commitTag, sourceTag],
  );
}

/**
 * The same resolution as a callback, for code paths outside a render (an
 * event handler, a poll) that must read the CURRENT tags rather than the ones
 * captured when the component last rendered.
 */
export function useResolveHistoryProvider(): (modelId: string) => ResolvedHistorySource | null {
  const host = useOptionalSourceHost();
  return useCallback(
    (modelId: string) => {
      const state = useViewerStore.getState();
      return resolve(host, state.commitTags.get(modelId), state.sourceTags.get(modelId));
    },
    [host],
  );
}

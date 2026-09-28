/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Change detection for commit-tagged models — the commit twin of
 * `revisionWatch.ts`, sharing its interval guard and its cursor persistence.
 *
 * Shared deliberately: two independent poll schedules against one CDE is a
 * poll storm with two authors, and the reason `claimRevisionWatchSlot` exists
 * at all is that opening and closing a panel repeatedly must not become one.
 */

import type { CommitEvent, ModelRef } from '@ifc-lite/plugin-api';
import type { SourceHost } from '@/services/sources/source-host';
import type { CommitTag } from '@/store/slices/historySlice';

import { loadResolvedSourcePrefs } from './preferences';
import { loadRevisionWatchCursor, saveRevisionWatchCursor } from './persistence';

export interface CommitHeadUpdate {
  /** Viewer model id. */
  readonly modelId: string;
  readonly providerTitle: string;
  readonly event: CommitEvent;
}

/**
 * One `watchCommits` call per provider + project.
 *
 * A model whose loaded commit is already the reported head produces NO
 * update: the whole banner exists to say "there is something newer than what
 * you are looking at", and firing it for the commit already on screen is how
 * a notification becomes noise the user learns to dismiss.
 */
export async function watchSourceCommits(
  sourceHost: SourceHost,
  commitTags: ReadonlyMap<string, CommitTag>,
  signal?: AbortSignal,
): Promise<CommitHeadUpdate[]> {
  interface Group {
    readonly provider: string;
    readonly projectId: string;
    readonly refs: ModelRef[];
    readonly modelIdsBySourceModel: Map<string, string[]>;
    readonly loadedCommitByModel: Map<string, string>;
  }

  const groups = new Map<string, Group>();
  for (const [modelId, tag] of commitTags) {
    const provider = sourceHost.get(tag.provider);
    if (!provider?.watchCommits || provider.manifest.capabilities.commits?.watch !== true) continue;

    const key = `${tag.provider}::${tag.projectId}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        provider: tag.provider,
        projectId: tag.projectId,
        refs: [],
        modelIdsBySourceModel: new Map(),
        loadedCommitByModel: new Map(),
      };
      groups.set(key, group);
    }
    if (!group.modelIdsBySourceModel.has(tag.sourceModelId)) {
      group.refs.push({ projectId: tag.projectId, modelId: tag.sourceModelId });
      group.modelIdsBySourceModel.set(tag.sourceModelId, []);
    }
    group.modelIdsBySourceModel.get(tag.sourceModelId)!.push(modelId);
    group.loadedCommitByModel.set(modelId, tag.commitId);
  }

  const updates: CommitHeadUpdate[] = [];
  for (const group of groups.values()) {
    if (signal?.aborted) break;
    const provider = sourceHost.get(group.provider);
    if (!provider?.watchCommits) continue;
    try {
      const ctx = sourceHost.createContext(provider.manifest, loadResolvedSourcePrefs(provider.manifest));
      // The cursor namespace is shared with the revision watch, suffixed so a
      // provider implementing both cannot be handed the other's token.
      const cursorKey = `${group.provider}:commits`;
      const cursor = loadRevisionWatchCursor(cursorKey, group.projectId);
      const result = await provider.watchCommits(ctx, group.refs, cursor, { signal });
      saveRevisionWatchCursor(cursorKey, group.projectId, result.cursor);

      for (const event of result.events) {
        for (const modelId of group.modelIdsBySourceModel.get(event.modelId) ?? []) {
          if (group.loadedCommitByModel.get(modelId) === event.headCommitId) continue;
          updates.push({ modelId, providerTitle: provider.manifest.title, event });
        }
      }
    } catch (error) {
      if (signal?.aborted) break;
      // Background nicety: a failure here must never surface as a panel error.
      console.warn(`[history] Commit watch failed for ${group.provider} project ${group.projectId}`, error);
    }
  }
  return updates;
}

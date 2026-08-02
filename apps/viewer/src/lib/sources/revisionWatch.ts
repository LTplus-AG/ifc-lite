/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { RevisionEvent, SourceFileRef, SourceTag } from '@ifc-lite/plugin-api';
import type { SourceHost } from '@/services/sources/source-host';
import { loadResolvedSourcePrefs } from './preferences';
import { loadRevisionWatchCursor, saveRevisionWatchCursor } from './persistence';

export interface SourceRevisionUpdate {
  readonly modelId: string;
  readonly providerTitle: string;
  readonly event: RevisionEvent;
}

/** Minimum spacing between change-detection passes. Opening and closing the
 *  panel repeatedly must not turn into a poll storm against providers that
 *  answer a watch with a full listing sweep. */
export const REVISION_WATCH_MIN_INTERVAL_MS = 5 * 60_000;
let lastWatchStartedAt = 0;

/** True when enough time has passed since the last pass; claims the slot. */
export function claimRevisionWatchSlot(now: number = Date.now()): boolean {
  if (now - lastWatchStartedAt < REVISION_WATCH_MIN_INTERVAL_MS) return false;
  lastWatchStartedAt = now;
  return true;
}

/**
 * Runs change detection over every source-tagged loaded model whose provider
 * declares `capabilities.changeDetection`, one `watchRevisions` call per
 * provider + project. The returned cursor is persisted per provider +
 * project so providers with a delta endpoint answer the next poll from a
 * single cheap request instead of a full re-sweep.
 *
 * Per-group failures are logged and skipped — change detection is a
 * background nicety and must never surface as a panel error.
 */
export async function watchSourceRevisions(
  sourceHost: SourceHost,
  sourceTags: ReadonlyMap<string, SourceTag>,
  signal?: AbortSignal,
): Promise<SourceRevisionUpdate[]> {
  interface Group {
    provider: string;
    projectId: string;
    refs: SourceFileRef[];
    modelIdsByFileId: Map<string, string[]>;
  }

  const groups = new Map<string, Group>();
  for (const [modelId, tag] of sourceTags) {
    const provider = sourceHost.get(tag.provider);
    if (!provider?.watchRevisions || !provider.manifest.capabilities.changeDetection) continue;

    const key = `${tag.provider}::${tag.projectId}`;
    let group = groups.get(key);
    if (!group) {
      group = { provider: tag.provider, projectId: tag.projectId, refs: [], modelIdsByFileId: new Map() };
      groups.set(key, group);
    }
    group.refs.push({ projectId: tag.projectId, containerId: tag.containerId, fileId: tag.fileId });
    const modelIds = group.modelIdsByFileId.get(tag.fileId);
    if (modelIds) modelIds.push(modelId);
    else group.modelIdsByFileId.set(tag.fileId, [modelId]);
  }

  const updates: SourceRevisionUpdate[] = [];
  for (const group of groups.values()) {
    if (signal?.aborted) break;
    const provider = sourceHost.get(group.provider);
    if (!provider?.watchRevisions) continue;

    try {
      const ctx = sourceHost.createContext(provider.manifest, loadResolvedSourcePrefs(provider.manifest));
      const cursor = loadRevisionWatchCursor(group.provider, group.projectId);
      const result = await provider.watchRevisions(ctx, group.refs, cursor, { signal });
      saveRevisionWatchCursor(group.provider, group.projectId, result.cursor);

      for (const event of result.events) {
        const modelIds = group.modelIdsByFileId.get(event.fileId);
        if (!modelIds) continue;
        for (const modelId of modelIds) {
          updates.push({ modelId, providerTitle: provider.manifest.title, event });
        }
      }
    } catch (err) {
      if (signal?.aborted) break;
      console.warn(
        `[sources] Revision watch failed for ${group.provider} project ${group.projectId}`,
        err,
      );
    }
  }
  return updates;
}

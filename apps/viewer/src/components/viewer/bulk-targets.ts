/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { EntityRef } from '@/store/types.js';
import type { SearchResult } from '@/lib/search/tier0-scan.js';

export type BulkTargetSource = 'selection' | 'search' | 'query';

/** Preserve model identity while deduplicating repeated picks and search hits. */
export function uniqueBulkTargets(targets: Iterable<EntityRef>): EntityRef[] {
  const seen = new Set<string>();
  const result: EntityRef[] = [];
  for (const target of targets) {
    if (!target.modelId || !Number.isSafeInteger(target.expressId) || target.expressId <= 0) continue;
    const key = `${target.modelId}:${target.expressId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(target);
  }
  return result;
}

export function selectedBulkTargets(
  globalIds: Iterable<number>,
  resolve: (globalId: number) => EntityRef,
): EntityRef[] {
  return uniqueBulkTargets(Array.from(globalIds, resolve));
}

export function searchedBulkTargets(results: Iterable<Pick<SearchResult, 'modelId' | 'expressId'>>): EntityRef[] {
  return uniqueBulkTargets(results);
}

export function groupBulkTargets(targets: readonly EntityRef[]): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  for (const { modelId, expressId } of targets) {
    const group = groups.get(modelId) ?? [];
    group.push(expressId);
    groups.set(modelId, group);
  }
  return groups;
}

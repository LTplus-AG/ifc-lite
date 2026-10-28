/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { diffIdentityMapFromContentMatches, diffIdentityMapFromSuccessors, diffLineageOfDiff } from '@ifc-lite/wasm/diff';
import { diffModelConstructor } from './wasm-runtime.js';
import { projectAcceptedSuccessors, projectContentMatches, projectLineageDiff } from './wasm-projections.js';
import type { IdentityMapEntry } from './identity-map.js';
import type { LineageEntry, LineageFromDiffOptions } from './lineage.js';
import type { ContentMatch, ModelDiff, SuccessorClaim } from './types.js';

export function identityMapFromContentMatches<TRef>(matches: Iterable<ContentMatch<TRef>> | undefined): IdentityMapEntry[] {
  diffModelConstructor();
  return diffIdentityMapFromContentMatches(projectContentMatches(matches)) as IdentityMapEntry[];
}

export function identityMapFromSuccessors<TRef>(accepted: Iterable<SuccessorClaim<TRef>> | undefined): IdentityMapEntry[] {
  diffModelConstructor();
  return diffIdentityMapFromSuccessors(projectAcceptedSuccessors(accepted)) as IdentityMapEntry[];
}

export function lineageOfDiff<TRef>(diff: ModelDiff<TRef>, options: LineageFromDiffOptions<TRef> = {}): { entries: LineageEntry[]; deleted: string[] } {
  diffModelConstructor();
  return diffLineageOfDiff(projectLineageDiff(diff), projectAcceptedSuccessors(options.accepted),
    [...options.aliasReasons ?? []], [...options.aliasRelations ?? []]) as { entries: LineageEntry[]; deleted: string[] };
}

export function lineageFromDiff<TRef>(diff: ModelDiff<TRef>, options: LineageFromDiffOptions<TRef> = {}): LineageEntry[] {
  return lineageOfDiff(diff, options).entries;
}

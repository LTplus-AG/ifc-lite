/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The lineage half of `ifc-lite diff --by-content` (issue #4955): reading a
 * pinned lineage sidecar, merging two alias sources, and deciding what the
 * output lineage carries. Split out of `diff-content.ts` for size; that
 * module still owns the command.
 */

import { readFile } from 'node:fs/promises';
import {
  lineageOfDiff,
  lineageSidecarMismatches,
  parseLineageSidecar,
  SUCCESSOR_REASON_PREFIX,
  type IdentityMapSidecar,
  type LineageEntry,
  type LineageSidecar,
  type ModelDiff,
  type ModelIdentity,
} from '@ifc-lite/diff';
import { fatal } from '../output.js';
import type { DiffRef } from './diff-engine.js';

/** Union of two alias maps; a head key the two disagree about is dropped. */
export function mergeAliases(
  a: Map<string, string> | undefined,
  b: Map<string, string> | undefined,
): Map<string, string> | undefined {
  if (!a) return b;
  if (!b) return a;
  const merged = new Map(a);
  for (const [here, base] of b) {
    const existing = merged.get(here);
    if (existing === undefined) merged.set(here, base);
    else if (existing !== base) merged.delete(here);
  }
  return merged;
}

/**
 * The lineage the output should carry: every entry this run derived (committed
 * matches, plus `replaced` from the accepted map), with the incoming lineage's
 * own provenance preserved on the aliases that still applied. Split/merge
 * entries an earlier geometry-capable run wrote are carried forward verbatim
 * when every key they name is still absent from this run's 1:1 answers — this
 * data-scope run cannot re-derive or refute them, and dropping them would make
 * a CLI round trip erase what the viewer established.
 */
export function mergeLineage(
  incomingLineage: LineageSidecar | undefined,
  incomingMap: IdentityMapSidecar | undefined,
  diff: ModelDiff<DiffRef>,
  accepted: IdentityMapSidecar | undefined,
): { entries: LineageEntry[]; deleted: string[] } {
  const aliasReasons = new Map<string, string>();
  const aliasRelations = new Map<string, 'identity' | 'replaced'>();
  for (const entry of incomingLineage?.entries ?? []) {
    if (entry.head.length === 1 && !aliasReasons.has(entry.head[0])) {
      aliasReasons.set(entry.head[0], entry.reason);
      if (entry.relation === 'identity' || entry.relation === 'replaced') {
        aliasRelations.set(entry.head[0], entry.relation);
      }
    }
  }
  for (const entry of incomingMap?.entries ?? []) {
    if (!aliasReasons.has(entry.here)) aliasReasons.set(entry.here, entry.reason);
  }
  const { entries } = lineageOfDiff(diff, { aliasReasons, aliasRelations });
  const taken = new Set<string>();
  for (const entry of entries) for (const key of [...entry.base, ...entry.head]) taken.add(key);

  for (const entry of accepted?.entries ?? []) {
    if (entry.base === entry.here || taken.has(entry.base) || taken.has(entry.here)) continue;
    // Only a pair this run still sees as add + delete can be a replacement;
    // a claim about keys not in these files is stale.
    if (diff.byKey.get(entry.base)?.state !== 'deleted' || diff.byKey.get(entry.here)?.state !== 'added') continue;
    // Same contract as `lineage.ts`'s own accepted-successor fold (issue
    // #4989 review): only a HAND-WRITTEN `successor:*` reason is a
    // replacement claim; a viewer-exported `accepted:ambiguous` entry is a
    // plain identity decision, and writing it `replaced` here meant the
    // next `--lineage-in l --lineage-out l` round trip (which reads THIS
    // file's own `relation` back, not the reason) silently flipped it.
    const relation = entry.reason.startsWith(SUCCESSOR_REASON_PREFIX) ? 'replaced' : 'identity';
    entries.push({ base: [entry.base], head: [entry.here], relation, reason: entry.reason });
    taken.add(entry.base);
    taken.add(entry.here);
  }
  for (const entry of incomingLineage?.entries ?? []) {
    if (entry.relation !== 'split' && entry.relation !== 'merge') continue;
    if ([...entry.base, ...entry.head].some((key) => taken.has(key))) continue;
    entries.push(entry);
    for (const key of [...entry.base, ...entry.head]) taken.add(key);
  }
  // Deleted with no lineage, computed AFTER the accepted and carried-forward
  // entries took their keys: what is still a bare deletion in this run.
  const deleted: string[] = [];
  for (const entry of diff.entries) {
    if (entry.state === 'deleted' && !taken.has(entry.key)) deleted.push(entry.key);
  }
  return { entries, deleted };
}

export async function readVerifiedLineage(
  path: string,
  models: { base: ModelIdentity; head: ModelIdentity; keyProperty?: string },
): Promise<LineageSidecar> {
  let text: string;
  try {
    text = await readFile(path, 'utf-8');
  } catch (error) {
    return fatal(`Cannot read lineage ${path}: ${(error as Error).message}`);
  }
  let sidecar: LineageSidecar;
  try {
    sidecar = parseLineageSidecar(text);
  } catch (error) {
    return fatal((error as Error).message);
  }
  const problems = lineageSidecarMismatches(sidecar, models);
  if (problems.length > 0) {
    return fatal(`Lineage ${path} was not verified against these files:\n  ${problems.join('\n  ')}`);
  }
  return sidecar;
}

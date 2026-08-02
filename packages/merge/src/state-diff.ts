/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The shared layer-diff JSON (roadmap cross-cutting item): ONE shape,
 * ONE implementation, consumed identically by the CLI (`ifc layer
 * diff --json`), the MCP `diff_layer` tool, and the review UI. Output is
 * deterministically ordered (paths and component keys sorted) so equal
 * states always serialize to byte-equal JSON.
 */

import type { IfcxFile } from '@ifc-lite/ifcx';
import { componentEntries, extractStackState, snapshotOf } from './component-state.js';
import type { StackState } from './component-state.js';

export interface ModifiedEntity {
  path: string;
  /** Component keys whose value changed, was added, or was removed. Sorted. */
  components: string[];
}

/** The wire shape every transport emits verbatim. */
export interface StackDiff {
  added: string[];
  deleted: string[];
  modified: ModifiedEntity[];
}

function alive(state: StackState, path: string): boolean {
  const entity = state.get(path);
  return entity !== undefined && !entity.deleted;
}

/** Diff two composed states: `from` (base) → `to` (target). */
export function diffStackStates(from: StackState, to: StackState): StackDiff {
  const added: string[] = [];
  const deleted: string[] = [];
  const modified: ModifiedEntity[] = [];

  const paths = [...new Set<string>([...from.keys(), ...to.keys()])].sort();
  for (const path of paths) {
    const inFrom = alive(from, path);
    const inTo = alive(to, path);
    if (!inFrom && inTo) {
      added.push(path);
      continue;
    }
    if (inFrom && !inTo) {
      deleted.push(path);
      continue;
    }
    if (!inFrom && !inTo) continue;

    const fromEntity = from.get(path);
    const toEntity = to.get(path);
    if (!fromEntity || !toEntity) continue;
    const fromComponents = componentEntries(fromEntity);
    const toComponents = componentEntries(toEntity);
    const keys = [...new Set<string>([...fromComponents.keys(), ...toComponents.keys()])].sort();
    const changed: string[] = [];
    for (const key of keys) {
      const a = fromComponents.get(key);
      const b = toComponents.get(key);
      if (a === b) continue;
      const aHash = a === undefined ? undefined : snapshotOf(a).hash;
      const bHash = b === undefined ? undefined : snapshotOf(b).hash;
      if (aHash !== bHash) changed.push(key);
    }
    if (changed.length > 0) modified.push({ path, components: changed });
  }

  return { added, deleted, modified };
}

/** Diff two ordered layer lists (`from` is the base side). */
export function diffLayerStacks(from: readonly IfcxFile[], to: readonly IfcxFile[]): StackDiff {
  return diffStackStates(extractStackState(from), extractStackState(to));
}

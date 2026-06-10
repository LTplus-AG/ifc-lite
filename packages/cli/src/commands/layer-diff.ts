/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite layer diff` — compare two composed states. Each side resolves
 * to an ordered layer list (a ref's stack, a stored layer, or an .ifcx
 * file). The diff itself is the shared contract in `@ifc-lite/merge`
 * (state-diff.ts): CLI, MCP, and the review UI emit the identical JSON.
 */

import { diffLayerStacks } from '@ifc-lite/merge';
import { getFlag, hasFlag, printJson } from '../output.js';
import { resolveSide, storeFromArgs } from './layer-store.js';

// Re-exported under the historical CLI names for existing imports.
export {
  diffLayerStacks,
  diffStackStates as diffStates,
  type ModifiedEntity,
  type StackDiff as LayerDiffResult,
} from '@ifc-lite/merge';

export async function layerDiffCommand(args: string[]): Promise<void> {
  const store = storeFromArgs(args);
  const target = args[0];
  if (!target || target.startsWith('-')) {
    throw new Error(
      'Usage: ifc-lite layer diff <layer-id|ref|file.ifcx> [--against <layer-id|ref|file.ifcx>] [--components] [--json]'
    );
  }
  const againstSpec = getFlag(args, '--against');

  const to = resolveSide(store, target);
  const from = againstSpec
    ? resolveSide(store, againstSpec)
    : { kind: 'ref' as const, layers: [], label: '(empty)' };
  const result = diffLayerStacks(from.layers, to.layers);

  if (hasFlag(args, '--json')) {
    printJson(result);
    return;
  }

  process.stdout.write(`diff ${from.label} → ${to.label}\n`);
  process.stdout.write(
    `${result.added.length} added, ${result.deleted.length} deleted, ${result.modified.length} modified\n`
  );
  for (const path of result.added) process.stdout.write(`  A ${path}\n`);
  for (const path of result.deleted) process.stdout.write(`  D ${path}\n`);
  const showComponents = hasFlag(args, '--components');
  for (const entry of result.modified) {
    process.stdout.write(`  M ${entry.path}\n`);
    if (showComponents) {
      for (const key of entry.components) process.stdout.write(`      ~ ${key}\n`);
    }
  }
}

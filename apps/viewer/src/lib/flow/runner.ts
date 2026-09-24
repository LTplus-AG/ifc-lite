/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Running a graph inside the viewer.
 *
 * - The graph's declared `capabilities` are the grants (the author declared
 *   them; a consent step for installed graphs is the `.iflx` channel's job).
 * - Every write lands in the viewer change set inside ONE undo batch
 *   (`bim.mutate.batchAsync`), so Ctrl+Z reverts the whole run.
 * - Tracked element sets live in `BrowserTrackingStore`, pinned to the
 *   active model's content hash.
 * - The memo cache survives between runs; `invalidateForExternalChange`
 *   drops it when the model changed under the graph (a user edit, a model
 *   load) — the graph's own writes are covered by the cache's write
 *   generation and must not clear it.
 */

import { parseCapabilities } from '@ifc-lite/extensions';
import { runFlow, type FlowDocument, type MemoCache, type RunResult } from '@ifc-lite/flow';
import { BROWSER_FEATURES, createStandardRegistry, invalidateGlobalIdIndex, type FlowHost } from '@ifc-lite/flow-nodes';
import type { BimContext } from '@ifc-lite/sdk';
import { BrowserTrackingStore } from './persistence.js';

let registry: ReturnType<typeof createStandardRegistry> | undefined;

/** The standard registry, built once per page. */
export function flowRegistry(): ReturnType<typeof createStandardRegistry> {
  registry ??= createStandardRegistry();
  return registry;
}

export interface ViewerRunInput {
  readonly doc: FlowDocument;
  readonly bim: BimContext;
  /** Model content hash the tracked sets are pinned to (`sourceContentHash`), or the model id. */
  readonly pin: string;
  readonly cache: MemoCache;
  readonly inputs?: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
  /** Entity-table access for `table.joinByKey`'s tag/property strategies — see `viewer-tables.ts`. */
  readonly tables?: FlowHost['tables'];
}

export class FlowCapabilityError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`the graph declares malformed capabilities: ${problems.join('; ')}`);
    this.name = 'FlowCapabilityError';
  }
}

export async function runFlowInViewer(input: ViewerRunInput): Promise<RunResult> {
  const parsed = parseCapabilities(input.doc.capabilities);
  if (!parsed.ok) throw new FlowCapabilityError(parsed.errors.map((e) => e.message));
  const host: FlowHost = {
    bim: input.bim,
    grants: parsed.value,
    defaultModelId: input.bim.model.activeId() ?? undefined,
    ...(input.tables ? { tables: input.tables } : {}),
  };
  const tracking = new BrowserTrackingStore(input.doc.id, input.pin);
  const result = await input.bim.mutate.batchAsync(`flow:${input.doc.name}`, () =>
    runFlow(input.doc, {
      host,
      registry: flowRegistry(),
      features: BROWSER_FEATURES,
      cache: input.cache,
      tracking,
      inputs: input.inputs,
      signal: input.signal,
    }),
  );
  // The model was written but the sets were not saved: the next run would
  // not know these elements exist. That is a failed run, not a green one.
  if (tracking.persistError === undefined) return result;
  return {
    ...result,
    ok: false,
    log: [...result.log, { nodeId: TRACKING_NODE_ID, laneKey: null, level: 'error', message: `tracked sets could not be saved to browser storage: ${tracking.persistError}` }],
  };
}

/** Log entries about the tracking store itself carry this in place of a node id. */
export const TRACKING_NODE_ID = '(tracking)';

/** The model changed under the graph: drop memos and the GlobalId index. */
export function invalidateForExternalChange(bim: BimContext, cache: MemoCache): void {
  cache.invalidate();
  invalidateGlobalIdIndex(bim);
}

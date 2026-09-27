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
import { BROWSER_FEATURES, createStandardRegistry, invalidateGlobalIdIndex, referencedSecrets, type FlowHost } from '@ifc-lite/flow-nodes';
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
  /** Loads a model for `model.openFromSource` through `addModel` — see `open-model.ts`. */
  readonly openModel?: FlowHost['openModel'];
}

export class FlowCapabilityError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`the graph declares malformed capabilities: ${problems.join('; ')}`);
    this.name = 'FlowCapabilityError';
  }
}

/**
 * The browser has no `process.env` and must never persist a secret, so
 * `HostFeatures.secrets` is always empty here (`BROWSER_FEATURES`). A graph
 * that references `{{secret:NAME}}` anywhere would otherwise interpolate
 * nothing (or fail deep inside a node, after other nodes already ran) — this
 * is the viewer's own pre-flight check, thrown BEFORE `runFlow` starts, so
 * the failure is reported up front like `FlowCapabilityError` rather than
 * mid-run (#5167 phase 3.5). The CLI/MCP entry points never hit this class:
 * their `HostFeatures.secrets` reflects the real environment, and their own
 * `validateSecretReferences` runs the equivalent check against it.
 */
export class FlowSecretUnavailableError extends Error {
  constructor(readonly names: readonly string[]) {
    super(`this graph references secret(s) ${names.join(', ')}, which are never available in the viewer — run it via the CLI or MCP instead`);
    this.name = 'FlowSecretUnavailableError';
  }
}

export async function runFlowInViewer(input: ViewerRunInput): Promise<RunResult> {
  const parsed = parseCapabilities(input.doc.capabilities);
  if (!parsed.ok) throw new FlowCapabilityError(parsed.errors.map((e) => e.message));
  const secretNames = [...new Set(referencedSecrets(input.doc).map((r) => r.name))];
  if (secretNames.length > 0) throw new FlowSecretUnavailableError(secretNames);
  // `networkGrants` is the SAME parsed capability list as `grants` here: the
  // viewer always gates on the author's declared capabilities (there is no
  // "trusted, no gate" mode in the browser). A CORS-blocked `http.request`
  // surfaces its own explicit error (see `network-request.ts`'s
  // `describeFetchFailure`) rather than an empty success.
  const host: FlowHost = {
    bim: input.bim,
    grants: parsed.value,
    networkGrants: parsed.value,
    defaultModelId: input.bim.model.activeId() ?? undefined,
    ...(input.tables ? { tables: input.tables } : {}),
    ...(input.openModel ? { openModel: input.openModel } : {}),
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

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The processed-model branch of `useIfcLoader`'s one load path. A processed
 * model has no source bytes here, so nothing of the local path (sniffing,
 * local cache, WASM fallback) applies: the server replays the stored result,
 * and its failure is worded for the user with no fallback.
 *
 * A primary writes the active slot as it streams, and its properties hydrate
 * after it is registered. A federated slot must not touch the active slot (it
 * belongs to another model), so its geometry and its properties are collected
 * in a {@link ServedModelSink} and the model registers whole at finalize, like
 * a local federated file.
 */

import type { GeometryResult } from '@ifc-lite/geometry';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { FederatedModel } from '@/store';
import type { ProcessedModelRecord } from '@/lib/processed-model';
import { handleServerLoadAttempt } from './serverLoadAttempt.js';
import { describeProcessedModelFailure, failedFederatedProcessedModel, ProcessedModelUnavailable } from './processedModel.js';

/**
 * Where a federated load's served model goes instead of the active slot. The
 * server load fills it; the loader's completion reads it.
 */
export interface ServedModelSink {
  /** The latest geometry the server sent; the final one once the load returns true. */
  geometry: GeometryResult | null;
  /** Fetches and decodes the properties; set once the load returns true. `null` when the server has none. */
  properties: ((signal: AbortSignal) => Promise<IfcDataStore | null>) | null;
}

/**
 * The store and geometry a federated slot collected. It needs its store before it
 * registers, because the store (entities without geometry included) decides
 * its ID range before a later slot takes the next. `null` when superseded.
 */
export async function servedModelParts(
  served: ServedModelSink,
  signal: AbortSignal,
  isStale: () => boolean,
): Promise<{ ifcDataStore: IfcDataStore; geometryResult: GeometryResult | null } | null> {
  const ifcDataStore = await served.properties?.(signal) ?? null;
  if (isStale()) return null;
  if (!ifcDataStore) throw new ProcessedModelUnavailable('no-properties');
  return { ifcDataStore, geometryResult: served.geometry };
}

export interface ProcessedModelLoad {
  federated: false | { name: string; visible?: boolean; loadedAt?: number };
  modelId: string;
  processedModel: ProcessedModelRecord;
  isStale: () => boolean;
  /** The server load; `sink` is set for a federated slot. Throws the cause a processed model reports. */
  load: (sink: ServedModelSink | undefined) => Promise<boolean>;
  complete: (served: ServedModelSink | undefined) => Promise<void>;
  showLoadError: (message: string, code: string, retry?: (() => void) | null) => void;
  settleLoadUi: () => void;
  upsertModel: (model: FederatedModel) => void;
  updateModel: (modelId: string, patch: Partial<FederatedModel>) => void;
}

/** Run one processed-model load to its end: completed, superseded, or failed with its own card. */
export async function runProcessedModelLoad(run: ProcessedModelLoad): Promise<void> {
  let failure: unknown = null;
  const served: ServedModelSink | undefined = run.federated ? { geometry: null, properties: null } : undefined;
  // A federated slot's completion can fail too (no properties); it ends in the same card as a load failure.
  let servedFailed = false;
  const complete = served
    ? () => run.complete(served).catch((error: unknown) => { servedFailed = true; failure = error; })
    : () => run.complete(undefined);
  const load = () => run.load(served).catch((error: unknown) => { failure = error; return false; });
  if (await handleServerLoadAttempt(load, run.isStale, complete) && !servedFailed) return;
  if (run.isStale()) return;
  const { message, code, retryable } = describeProcessedModelFailure(failure);
  // A failed slot is listed beside the loaded ones, like a failed primary.
  if (run.federated) {
    run.upsertModel(failedFederatedProcessedModel({ id: run.modelId, ...run.federated, processedModel: run.processedModel, message }));
  } else {
    run.updateModel(run.modelId, { loadState: 'error', loadError: message });
  }
  run.showLoadError(message, code, retryable ? undefined : null);
  run.settleLoadUi();
}

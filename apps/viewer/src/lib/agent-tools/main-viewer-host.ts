/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The main viewer as an agent tool host (#9523).
 *
 * Unlike the playground, the main viewer holds the user's live session: every
 * federated model, and the edits they have not saved yet. Those edits live in
 * the store's `mutationViews`, so a model is never re-wrapped in a backend of
 * its own (that would keep a second, empty overlay). Reads go through the
 * viewer's own `BimContext` (`useBim()`), whose adapters fold that overlay in,
 * and the overlay itself is read with `getMutationViewForModel`.
 *
 * The host is a view over the store, read on every call: nothing about the
 * session is cached here, and nothing here is module state.
 */

import { BsddNamespace, type BimContext } from '@ifc-lite/sdk';
import type { FederatedModel, ViewerState } from '@/store';
import { isIfcxDataStore } from '@/store/types';
import { getAllModelEntries, type ModelLike } from '@/sdk/adapters/model-compat';
import { getMutationViewForModel } from '@/sdk/adapters/mutation-view';
import type { StoreApi } from '@/sdk/adapters/types';
import type { BsddClient, ModelHandle, ModelStatus, ToolHost } from './types.js';

export interface MainViewerToolHostOptions {
  /** Defaults to a client through this site's `/api/bsdd` proxy (the public endpoint fails CORS). */
  bsdd?: BsddClient;
}

const LOADING_STATES = new Set<FederatedModel['loadState']>(['pending', 'streaming-geometry', 'hydrating-metadata']);

/**
 * Loads whose store is synthetic: entity-less (LandXML, splats) or holding one
 * invented `IfcGeographicElement` (point cloud), with an empty `source`. They
 * exist to give the model a federation id range, not to be read as IFC.
 */
const SYNTHETIC_LOAD_PATHS = new Set<FederatedModel['loadPath']>(['landxml', 'point-cloud', 'gaussian']);

/** Why a loaded entry can or cannot answer model tools (layer composition is decided by the caller). */
export function mainViewerModelStatus(entry: ModelLike, federated: FederatedModel | undefined): ModelStatus {
  if (federated?.loadState === 'error') return 'failed';
  if (LOADING_STATES.has(federated?.loadState)) return 'loading';
  const store = entry.ifcDataStore;
  if (!store) return 'no-data';
  if (SYNTHETIC_LOAD_PATHS.has(federated?.loadPath) || federated?.landXmlDocument) return 'no-data';
  if (federated?.loadPath === 'server') return 'server-partial';
  // IFCX keeps its JSON in `source`, so a non-empty source is not a STEP source.
  if (isIfcxDataStore(store)) return 'no-step-source';
  if ((store.source?.byteLength ?? 0) === 0) return 'no-step-source';
  return 'ready';
}

/**
 * Models that share one store (a federated IFCX composition publishes every
 * layer as a model over the composed store) are one model to the tools. The
 * owner is the model the viewer resolves selections, and so edits, to:
 * `resolveGlobalIdFromModels` matches only models with a parse range
 * (`maxExpressId > 0`), lowest `idOffset` first. Every other sharer is a
 * `composed-layer` pointing at it, never a second answer for the same data.
 */
function compositionOwners(entries: Array<[string, ModelLike]>, state: ViewerState): Map<string, string> {
  const sharers = new Map<object, string[]>();
  for (const [id, entry] of entries) {
    if (!entry.ifcDataStore) continue;
    const ids = sharers.get(entry.ifcDataStore);
    if (ids) ids.push(id);
    else sharers.set(entry.ifcDataStore, [id]);
  }
  const ownerOf = new Map<string, string>();
  for (const ids of sharers.values()) {
    if (ids.length < 2) continue;
    const ranked = ids
      .map((id) => state.models.get(id))
      .filter((m): m is FederatedModel => m !== undefined)
      .sort((a, b) => a.idOffset - b.idOffset);
    const owner = ranked.find((m) => (m.maxExpressId ?? 0) > 0) ?? ranked[0];
    if (!owner) continue;
    for (const id of ids) if (id !== owner.id) ownerOf.set(id, owner.id);
  }
  return ownerOf;
}

/**
 * A tool host over the main viewer's store and its `BimContext`.
 *
 * `bim` must be the context backed by this same store (the one `useBim()`
 * returns), so a ref a tool builds and the overlay it reads describe one model.
 */
export function createMainViewerToolHost(
  store: StoreApi,
  bim: BimContext,
  options: MainViewerToolHostOptions = {},
): ToolHost {
  const bsdd = options.bsdd ?? new BsddNamespace({ apiBase: '/api/bsdd' });
  return {
    bsdd,
    models(): ModelHandle[] {
      const state: ViewerState = store.getState();
      const entries = getAllModelEntries(state);
      const ownerOf = compositionOwners(entries, state);
      return entries.map(([id, entry]) => {
        const composedInto = ownerOf.get(id);
        return {
          id,
          name: entry.name,
          fileSize: entry.fileSize,
          status: composedInto ? 'composed-layer' : mainViewerModelStatus(entry, state.models.get(id)),
          ...(composedInto ? { composedInto } : {}),
          store: entry.ifcDataStore,
          bim,
          mutationView: () => getMutationViewForModel(store, id),
        };
      });
    },
  };
}

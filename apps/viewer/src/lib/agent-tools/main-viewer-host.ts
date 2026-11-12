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
import { getAllModelEntries, type ModelLike } from '@/sdk/adapters/model-compat';
import { getMutationViewForModel } from '@/sdk/adapters/mutation-view';
import type { StoreApi } from '@/sdk/adapters/types';
import type { BsddClient, ModelHandle, ModelStatus, ToolHost } from './types.js';

export interface MainViewerToolHostOptions {
  /** Defaults to a client through this site's `/api/bsdd` proxy (the public endpoint fails CORS). */
  bsdd?: BsddClient;
}

const LOADING_STATES = new Set<FederatedModel['loadState']>(['pending', 'streaming-geometry', 'hydrating-metadata']);

/** Why a loaded entry can or cannot answer model tools. */
export function mainViewerModelStatus(entry: ModelLike, federated: FederatedModel | undefined): ModelStatus {
  if (federated?.loadState === 'error') return 'failed';
  if (LOADING_STATES.has(federated?.loadState)) return 'loading';
  const store = entry.ifcDataStore;
  if (!store) return 'no-data';
  if (federated?.loadPath === 'server') return 'server-partial';
  if ((store.source?.byteLength ?? 0) === 0) return 'no-step-source';
  return 'ready';
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
      return getAllModelEntries(state).map(([id, entry]) => ({
        id,
        name: entry.name,
        fileSize: entry.fileSize,
        status: mainViewerModelStatus(entry, state.models.get(id)),
        store: entry.ifcDataStore,
        bim,
        mutationView: () => getMutationViewForModel(store, id),
      }));
    },
  };
}

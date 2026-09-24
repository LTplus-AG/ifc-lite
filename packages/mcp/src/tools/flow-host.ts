/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `FlowHost` `run_flow` hands the graph. A `HeadlessLikeBackend` answers
 * for one model, so `openModel` (`model.openFromSource`) loads the bytes
 * through the same loader `load_model` uses, registers the result in the
 * session's model registry (later tool calls can address it by id), and
 * makes it the model `bim`, `defaultModelId` and `tables()` answer for for
 * the rest of the run.
 */

import type { Capability } from '@ifc-lite/extensions';
import type { FlowHost } from '@ifc-lite/flow-nodes';
import type { LoadedModel, ModelRegistry } from '../context.js';
import { deriveModelId, loadIfcModelFromBytes } from '../loader.js';

/** `base`, or `base_2`, `base_3`, … — the first id the registry does not hold yet. */
function freeModelId(registry: ModelRegistry, base: string): string {
  let id = base;
  for (let n = 2; registry.get(id) !== null; n += 1) id = `${base}_${n}`;
  return id;
}

export function createMcpFlowHost(initial: LoadedModel, registry: ModelRegistry, networkGrants: readonly Capability[]): FlowHost {
  let active = initial;
  return {
    get bim() { return active.bim; },
    networkGrants,
    get defaultModelId() { return active.id; },
    // `tables()` gives `table.joinByKey`'s tag/property strategies the entity
    // table, as the CLI and viewer hosts do — without it those strategies fail
    // at run time over MCP only. The mutation view is the one `bim.mutate`
    // writes through, so a join sees what an earlier node in the run wrote.
    tables: () => ({
      entities: active.store.entities,
      mutationView: active.backend.getOrCreateMutationView(),
      strings: active.store.strings ?? null,
    }),
    async openModel(bytes, name) {
      const loaded = await loadIfcModelFromBytes(bytes, name, freeModelId(registry, deriveModelId(name)));
      registry.add(loaded);
      active = loaded;
      return { modelId: loaded.id };
    },
  };
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `FlowHost` `ifc-lite flow run` hands the graph. A `HeadlessBackend`
 * answers for exactly one model, so `openModel` (`model.openFromSource`)
 * parses the downloaded bytes through the same loader `flow run` used for
 * the model on the command line, and makes that model the one `bim`,
 * `defaultModelId`, `tables()` — and the `--out` export — answer for from
 * then on. A file the loader rejects (not STEP, truncated, no DATA) fails
 * the node, never the process.
 */

import type { Capability } from '@ifc-lite/extensions';
import type { FlowHost } from '@ifc-lite/flow-nodes';
import type { IfcDataStore } from '@ifc-lite/parser';
import { createBimContext, type BimContext } from '@ifc-lite/sdk';
import { HeadlessBackend } from '../headless-backend.js';
import { parseIfcBytes } from '../loader.js';

export interface HeadlessModel {
  readonly bim: BimContext;
  readonly store: IfcDataStore;
  readonly backend: HeadlessBackend;
}

export interface CliFlowSession {
  readonly host: FlowHost;
  /** The model the graph is working on now: the command-line one, or the last one it opened. */
  active(): HeadlessModel;
}

export function createCliFlowSession(initial: HeadlessModel, networkGrants: readonly Capability[]): CliFlowSession {
  let active = initial;
  const host: FlowHost = {
    get bim() { return active.bim; },
    // `networkGrants` is always the graph's own declared capabilities: a
    // trusted local run is still not trusted to reach a host the graph never
    // declared (see `FlowHost.networkGrants`).
    networkGrants,
    get defaultModelId() { return active.bim.model.activeId() ?? undefined; },
    // `table.joinByKey`'s tag/property strategies reuse `@ifc-lite/mutations`'
    // csv-match.ts index builder, which needs the raw entity table + mutation
    // view rather than per-ref BimContext accessors (see host.ts's TableAccess).
    tables: (modelId) => active.backend.tableAccess(modelId),
    async openModel(bytes, name) {
      const store = await parseIfcBytes(bytes, name);
      const backend = new HeadlessBackend(store, name);
      active = { bim: createBimContext({ backend }), store, backend };
      return { modelId: active.bim.model.activeId() ?? name };
    },
  };
  return { host, active: () => active };
}

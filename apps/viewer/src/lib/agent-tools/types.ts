/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The host contract of the shared agent tool core (#9523).
 *
 * The same read tools serve two hosts: the `/mcp/playground` page, which
 * parses its own copy of a file, and the main viewer, which holds the user's
 * live federated session with its unsaved edits. A tool only ever sees a
 * {@link ToolHost} and the {@link ReadyModel} it was routed to, so it cannot
 * tell which host it runs in and cannot reach host-only state.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { BimContext, BsddNamespace } from '@ifc-lite/sdk';

/**
 * Whether a model can answer a tool, and if not, why.
 *
 * - `ready`: a parsed IFC store with its STEP source.
 * - `loading`: the model is still parsing or hydrating; retrying later works.
 * - `failed`: the load ended in an error.
 * - `no-data`: loaded without an IFC data store (GLB, point cloud, splats).
 * - `server-partial`: processed server-side; the tab holds tables, no STEP source.
 * - `no-step-source`: a store synthesised from a non-STEP source (IFCX, LandXML).
 */
export type ModelStatus = 'ready' | 'loading' | 'failed' | 'no-data' | 'server-partial' | 'no-step-source';

/** One model as the tools see it. */
export interface ModelHandle {
  /** The id refs carry (`EntityRef.modelId`) and `model_id` arguments name. */
  id: string;
  name: string;
  fileSize: number;
  status: ModelStatus;
  store: IfcDataStore | null;
  /** The SDK context that reads this model, including its pending edits. */
  bim: BimContext;
  /** This model's pending-edit overlay, read live on every call (null when unedited). */
  mutationView(): MutablePropertyView | null;
}

/** A handle whose store is present, which is what every model tool receives. */
export type ReadyModel = ModelHandle & { store: IfcDataStore };

/** The bSDD reads the tools make; the host decides the endpoint (e.g. a CORS proxy). */
export type BsddClient = Pick<BsddNamespace, 'search' | 'fetchClassInfo' | 'getPropertySets' | 'searchRelatedClasses'>;

export interface ToolHost {
  /** Every model the host holds, in display order. Read live on each call. */
  models(): ModelHandle[];
  bsdd: BsddClient;
}

export interface ToolCallContext {
  /** Cancellation of the call; tools check it between asynchronous phases. */
  signal?: AbortSignal;
}

/** What a tool returns on success. Failures are thrown as `ToolExecutionError`. */
export interface ToolOutput {
  text: string;
  structured: unknown;
}

/**
 * What a tool needs from its model, which decides how a host routes it:
 * `none` reads no model, `store` needs a parsed store (any source), and
 * `source` needs a store backed by its STEP source.
 */
export type ToolNeeds = 'none' | 'store' | 'source';

export type ModelFreeTool = {
  needs: 'none';
  run(host: ToolHost, args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolOutput>;
};

export type ModelTool = {
  needs: 'store' | 'source';
  run(host: ToolHost, model: ReadyModel, args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolOutput>;
};

export type AgentTool = ModelFreeTool | ModelTool;

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
import type { ChangeScalar } from '@ifc-lite/ai/artifacts';

/**
 * Whether a model can answer a tool, and if not, why.
 *
 * - `ready`: a parsed IFC store with its STEP source.
 * - `loading`: the model is still parsing or hydrating; retrying later works.
 * - `failed`: the load ended in an error.
 * - `server-partial`: processed server-side; the tab holds tables, no STEP source.
 * - `no-data`: loaded without IFC data: no store (a GLB opened as the primary
 *   model), or a synthetic store that exists only to give the model an id
 *   range (a GLB added to a federation, LandXML, point cloud, splats).
 * - `no-step-source`: real entity data, but not from an IFC STEP file (IFCX,
 *   whose `source` holds the IFCX JSON).
 * - `composed-layer`: one layer of a composition whose store another model
 *   owns (federated IFCX); `composedInto` names the model that answers for it.
 */
export type ModelStatus =
  | 'ready' | 'loading' | 'failed' | 'no-data' | 'server-partial' | 'no-step-source' | 'composed-layer';

/** One model as the tools see it. */
export interface ModelHandle {
  /** The id refs carry (`EntityRef.modelId`) and `model_id` arguments name. */
  id: string;
  name: string;
  fileSize: number;
  status: ModelStatus;
  /** For a `composed-layer`: the id of the model that owns the shared store. */
  composedInto?: string;
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
  /** Writes for the edit tools. Absent on a host that serves no edits (the playground). */
  editor?: ModelEditor;
}

/** A tool's argument schema: a JSON Schema object (`type: 'object'`). */
export interface AgentInputSchema {
  type: 'object';
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
}

/** A value an edit reads or writes (the reviewed-change scalar). */
export type EditScalar = ChangeScalar;

/**
 * One change an edit tool asks for, with the agent's values unchecked: the
 * editor validates them as a reviewed change. `expected`, when given, is the
 * value the agent read; the edit is refused if the model holds anything else
 * now (the user edited it meanwhile). Absent, the edit replaces what is there.
 */
export type AgentEditRequest =
  | { op: 'property.set'; pset: string; name: string; value: unknown; dataType?: unknown; expected?: unknown }
  | { op: 'property.delete'; pset: string; name: string; expected?: unknown }
  | { op: 'attribute.set'; name: string; value: unknown; expected?: unknown };

/** What one edit call changed, as its result and the activity log show it. */
export interface AgentEdit {
  modelId: string;
  expressId: number;
  globalId: string;
  /** IFC class of the entity, e.g. `IfcWall`. */
  entityType: string;
  /** `Pset_WallCommon.FireRating`, or an attribute name (`Name`). */
  field: string;
  before: EditScalar;
  /** null for a deleted property. */
  after: EditScalar;
  /** False when the model already held the value: nothing was written and no undo step was added. */
  changed: boolean;
}

export interface ModelEditor {
  /**
   * Apply one change to `model` as one undo step labelled as the agent's
   * `tool` call. Throws `ToolExecutionError` when the change is refused.
   */
  apply(model: ReadyModel, expressId: number, request: AgentEditRequest, tool: string): AgentEdit;
}

export interface ToolCallContext {
  /** Cancellation of the call; tools check it between asynchronous phases. */
  signal?: AbortSignal;
  /**
   * Called with the signal check at asynchronous phase boundaries; throws when
   * the host can no longer stand behind the answer (the main viewer: the model
   * was closed or replaced during the call).
   */
  checkpoint?: () => void;
  /**
   * Edit tools only: whether the user allows the agent to edit right now. Read
   * at the moment of the write, so a grant revoked while the call waited
   * refuses it. Absent means no.
   */
  canEdit?: () => boolean;
}

/** What a tool returns on success. Failures are thrown as `ToolExecutionError`. */
export interface ToolOutput {
  text: string;
  structured: unknown;
  /** Set by edit tools: what the call changed. */
  edit?: AgentEdit;
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

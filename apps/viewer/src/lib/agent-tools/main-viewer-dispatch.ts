/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The read-only tool surface the main viewer serves to a local agent (#9523).
 *
 * Only {@link MAIN_VIEWER_TOOL_ALLOWLIST} is reachable. Every other name is
 * refused even where the playground implements it: mutations, the inline
 * viewer, BCF, clash, exports and model load/save are not part of this
 * surface. Each call is routed to exactly one model (see `resolveModel`), so a
 * federated session never mixes models in one answer.
 *
 * This module is meant to be imported lazily, by the bridge client that hands
 * calls to it; nothing on the viewer's eager path imports it.
 */

import { ToolErrorCode, ToolExecutionError } from '@ifc-lite/mcp/browser';
import { isAbortError } from '@/lib/runs/abort';
import { LEGACY_MODEL_ID, LEGACY_MUTATION_MODEL_ID } from '@/sdk/adapters/model-compat';
import { CATALOG } from '@/components/mcp/data';
import { assertDispatchActive, cancelledDispatch } from './cancellation.js';
import { readTools } from './read-tools.js';
import { measureTools } from './measure-tools.js';
import { bsddTools } from './bsdd-tools.js';
import { isFeatureEnabled } from '../features/index.js';
import { costTools } from './cost-tools.js';
import { mainViewerIdsTools } from './main-viewer-ids.js';
import type { AgentTool, ModelHandle, ReadyModel, ToolHost, ToolNeeds } from './types.js';

/** Every tool the main viewer serves. Each must be a `read`-scope catalog tool (enforced by test). */
export const MAIN_VIEWER_TOOL_ALLOWLIST = [
  'model_info', 'model_list', 'schema_describe',
  'query_entities', 'count_entities', 'get_entity', 'get_entities_bulk',
  'spatial_hierarchy', 'containment_chain', 'relationships', 'properties_unique',
  'materials_list', 'classifications_list', 'georeferencing', 'units',
  'geometry_bbox', 'geometry_volume', 'geometry_area',
  'model_audit', 'ids_explain', 'ids_validate',
  'bsdd_search', 'bsdd_class', 'bsdd_property_sets', 'bsdd_match',
  'cost_data', 'cost_evaluate',
] as const;

export type MainViewerToolName = (typeof MAIN_VIEWER_TOOL_ALLOWLIST)[number];

const SHARED_TOOLS: Record<string, AgentTool> = {
  ...readTools, ...measureTools, ...bsddTools, ...costTools, ...mainViewerIdsTools,
};

/** The tool behind each allowlisted name, and nothing else. */
export function mainViewerTool(name: string): AgentTool | undefined {
  // bSDD is an outside service; a host can switch those off (`lib/features`).
  if (name in bsddTools && !isFeatureEnabled('privacy.third-party')) return undefined;
  return (MAIN_VIEWER_TOOL_ALLOWLIST as readonly string[]).includes(name) ? SHARED_TOOLS[name] : undefined;
}

/** A tool call's outcome, shaped like an MCP `CallToolResult`'s fields. */
export interface AgentToolResult {
  text: string;
  structured: unknown;
  isError: boolean;
  errorCode?: string;
  hint?: string;
}

const LEGACY_ALIASES = new Set(['legacy', LEGACY_MUTATION_MODEL_ID]);

function modelIds(models: ModelHandle[]): string {
  return models.map((model) => `'${model.id}' (${model.name})`).join(', ');
}

/**
 * The model a call is about: the one `model_id` names, or the only loaded one
 * (the layers of a composition count once, as their owner).
 * With several models loaded and no `model_id`, the call is refused with the
 * ids to choose from rather than guessing (the viewer's active model is UI
 * state, not something the agent can see).
 */
export function resolveModel(host: ToolHost, args: Record<string, unknown>): ModelHandle {
  const models = host.models();
  if (models.length === 0) {
    throw new ToolExecutionError({
      code: ToolErrorCode.MODEL_NOT_FOUND,
      message: 'No model is loaded in the viewer.',
      hint: 'Ask the user to open a model in the viewer tab, then retry.',
    });
  }
  const requested = typeof args.model_id === 'string' ? args.model_id.trim() : '';
  if (requested) {
    const match = models.find((model) => model.id === requested)
      ?? (models.length === 1 && models[0].id === LEGACY_MODEL_ID && LEGACY_ALIASES.has(requested) ? models[0] : undefined);
    if (match) return match;
    throw new ToolExecutionError({
      code: ToolErrorCode.MODEL_NOT_FOUND,
      message: `No model '${requested}' is loaded. Loaded: ${modelIds(models)}.`,
      details: { modelIds: models.map((model) => model.id) },
    });
  }
  // Layers of one composition are one model, so a composed file alone in the
  // viewer still counts as "the only model".
  const answering = models.filter((model) => model.status !== 'composed-layer');
  if (answering.length === 1) return answering[0];
  throw new ToolExecutionError({
    code: ToolErrorCode.MODEL_REQUIRED,
    message: `${answering.length} models are loaded; pass model_id to pick one: ${modelIds(answering)}.`,
    details: { modelIds: answering.map((model) => model.id) },
    hint: 'Call model_list for the ids and names.',
  });
}

const STATUS_MESSAGES: Record<Exclude<ModelHandle['status'], 'ready'>, (model: ModelHandle, tool: string) => [string, string?]> = {
  loading: (m) => [`Model '${m.name}' is still loading.`, 'Retry once the viewer has finished loading it.'],
  failed: (m) => [`Model '${m.name}' failed to load, so it cannot be read.`],
  'no-data': (m, tool) => [`Model '${m.name}' carries no IFC data in the viewer (geometry only), so ${tool} cannot read it.`],
  'server-partial': (m, tool) => [
    `Model '${m.name}' was processed on the server; the tab holds its tables but not the IFC source ${tool} reads.`,
    'Reopen the file in the viewer without server processing to use this tool.',
  ],
  'no-step-source': (m, tool) => [`Model '${m.name}' was not loaded from an IFC STEP file (e.g. IFCX), so ${tool} cannot read it.`],
  'composed-layer': (m) => [
    `Model '${m.name}' is one layer of a composed model; the composition answers as model '${m.composedInto}'.`,
    `Pass model_id '${m.composedInto}' instead.`,
  ],
};

const STORE_IS_ENOUGH = new Set<ModelHandle['status']>(['ready', 'server-partial', 'no-step-source']);

function hasStore(model: ModelHandle): model is ReadyModel {
  return model.store !== null;
}

/** The model as a tool may read it, or a specific refusal saying why it cannot. */
function usableModel(model: ModelHandle, needs: Exclude<ToolNeeds, 'none'>, tool: string): ReadyModel {
  const usable = needs === 'store' ? STORE_IS_ENOUGH.has(model.status) : model.status === 'ready';
  if (usable && hasStore(model)) return model;
  const status = model.status === 'ready' ? 'no-data' : model.status;
  const [message, hint] = STATUS_MESSAGES[status](model, tool);
  throw new ToolExecutionError({
    code: ToolErrorCode.UNSUPPORTED_OPERATION,
    message,
    details: { modelId: model.id, status, ...(model.composedInto ? { composedInto: model.composedInto } : {}) },
    ...(hint ? { hint } : {}),
  });
}

function refusal(toolName: string): AgentToolResult {
  const entry = CATALOG.tools.find((tool) => tool.name === toolName);
  if (!entry) {
    return { text: `Unknown tool: ${toolName}`, structured: null, isError: true, errorCode: ToolErrorCode.INVALID_INPUT };
  }
  if (entry.scope === 'mutate') {
    return {
      text: `${toolName} changes the model, and the viewer serves agents read-only.`,
      structured: { tool: toolName, scope: entry.scope },
      isError: true,
      errorCode: ToolErrorCode.READ_ONLY,
    };
  }
  return {
    text: `${toolName} is not available from the viewer; it serves only the read tools it listed when the agent connected.`,
    structured: { tool: toolName, scope: entry.scope },
    isError: true,
    errorCode: ToolErrorCode.UNSUPPORTED_OPERATION,
  };
}

/**
 * A model closed or replaced mid-call makes every later read return nothing,
 * which would come back as an empty success (an IDS run that "passes"). The
 * answer is refused instead when the id is gone or now holds another store.
 */
function assertModelCurrent(host: ToolHost, model: ReadyModel): void {
  const now = host.models().find((candidate) => candidate.id === model.id);
  if (now?.store === model.store) return;
  throw new ToolExecutionError({
    code: ToolErrorCode.STATE_CHANGED,
    message: `Model '${model.name}' was ${now ? 'replaced' : 'closed'} while the call ran, so its result was discarded.`,
    details: { modelId: model.id, reason: now ? 'replaced' : 'closed' },
    hint: 'Call model_list and retry against the model that is open now.',
  });
}

/** Settle as cancelled the moment `signal` aborts, instead of waiting on a lookup that cannot be interrupted. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(cancelledDispatch());
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/**
 * Run one tool call against the main viewer. Never throws: every failure,
 * including a refused tool name, comes back as an error result.
 */
export async function dispatchMainViewerTool(
  host: ToolHost,
  toolName: string,
  args: unknown,
  ctx: { signal?: AbortSignal } = {},
): Promise<AgentToolResult> {
  const tool = mainViewerTool(toolName);
  if (!tool) return refusal(toolName);
  try {
    if (args != null && (typeof args !== 'object' || Array.isArray(args))) {
      throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: 'Tool arguments must be a JSON object.' });
    }
    const input = (args ?? {}) as Record<string, unknown>;
    assertDispatchActive(ctx.signal);
    if (tool.needs === 'none') {
      const out = await untilAborted(tool.run(host, input, ctx), ctx.signal);
      return { text: out.text, structured: out.structured, isError: false };
    }
    const model = usableModel(resolveModel(host, input), tool.needs, toolName);
    const stillCurrent = () => assertModelCurrent(host, model);
    const out = await untilAborted(tool.run(host, model, input, { signal: ctx.signal, checkpoint: stillCurrent }), ctx.signal);
    // The work read whatever the store held; answer only if that is still this model.
    stillCurrent();
    return { text: out.text, structured: out.structured, isError: false };
  } catch (caught) {
    const err = isAbortError(caught) ? cancelledDispatch() : caught;
    if (err instanceof ToolExecutionError) {
      return { text: err.message, structured: err.details ?? null, isError: true, errorCode: err.code, hint: err.hint };
    }
    return {
      text: err instanceof Error ? err.message : String(err),
      structured: null,
      isError: true,
      errorCode: ToolErrorCode.INTERNAL_ERROR,
    };
  }
}

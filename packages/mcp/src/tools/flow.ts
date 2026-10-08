/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `describe_flow` / `run_flow` (#5167 Phase 4.3): expose `.flow.json` graphs
 * to MCP agents, mirroring `ifc-lite flow describe|run` (`@ifc-lite/cli`'s
 * `flow.ts`) exactly — same registry, same registry-aware wiring validation,
 * same "unknown --input key is refused, not dropped" rule. Both tools reuse
 * `@ifc-lite/flow`'s `describeFlowIO` / `resolveDeclaredParam` /
 * `unknownInputKeys` rather than a second copy, so the CLI and MCP surfaces
 * cannot drift on what counts as a declared parameter (see `introspect.ts`'s
 * module doc for the regression that rule exists to prevent).
 *
 * `describe_flow` never throws for a graph that parses but fails
 * registry-aware validation (`validateFlowWiring`): a declared output naming
 * a port no node has is exactly the defect an agent calls this tool to find,
 * so it comes back as `ok: false` with `diagnostics`, not an opaque error.
 * `parseFlowDocument` alone cannot see that defect (it is registry-free),
 * which is why this file runs wiring validation itself rather than reusing
 * the CLI's `loadDocument`.
 *
 * `run_flow` has no persistent tracking sidecar (unlike the CLI's
 * `FileTrackingStore`): each call gets a fresh `MemoryTrackingStore`, so a
 * tracked write node always plans its lanes as `create`. A flow that needs
 * update-in-place semantics across MCP calls has nowhere to remember its
 * tracked set yet — out of scope here; a future MCP-side sidecar (keyed per
 * session or per model) would close that gap.
 *
 * Wall/column/slab/beam/stair/railing creation nodes use the shared SDK
 * backend and create-package builders. Each creation is recorded as one
 * compound mutation for public mutation_undo, retaining earlier overlay work.
 * Stair/railing specs use their canonical builders; tracking remains per call.
 *
 * `run_flow` is the OTHER caller (besides `ifc-lite flow run`) allowed to
 * read `process.env` for a flow graph (#5167 phase 3.5), following the same
 * shared `@ifc-lite/flow-nodes` `secrets.ts` pipeline the CLI uses:
 * `validateSecretReferences` runs before anything else touches the graph
 * (an undeclared or unset `{{secret:NAME}}` is a `ToolExecutionError`, not a
 * silent empty string), `interpolateSecrets` substitutes into a throwaway
 * document, and `redactDeep` scrubs the whole tool result — outputs, logs,
 * errors — right before it crosses the MCP response boundary, so a secret
 * that comes back inside a response body a node fetched is still caught.
 * `networkGrants` is always the graph's own declared `network.fetch:<host>`
 * capabilities, independent of the (absent, here) general capability gate —
 * see `FlowHost.networkGrants`'s doc comment.
 */

import { readFile } from 'node:fs/promises';
import {
  checkAvailability,
  declaredInputKeys,
  describeFlowIO,
  migrateFlowDocument,
  MemoryTrackingStore,
  runFlow,
  unknownInputKeys,
  validateFlowDocument,
  validateFlowWiring,
  type DocumentProblem,
  type FlowData,
  type FlowDocument,
  type RunResult,
  type Table,
} from '@ifc-lite/flow';
import { parseCapabilities } from '@ifc-lite/extensions';
import {
  buildRedactionMap,
  createStandardRegistry,
  interpolateSecrets,
  redactDeep,
  resolveSecretValues,
  validateSecretReferences,
} from '@ifc-lite/flow-nodes';
// AI availability follows explicit host configuration; unconfigured hosts refuse before effects.
import { mcpFlowFeatures } from './flow-ai.js';
import { prepareMcpFlowReview, restoredMcpNodes } from './flow-review-host.js';
import { flowAiConfig } from '@ifc-lite/ai/chat-completions';
import { aiNodes } from '@ifc-lite/flow-nodes/ai';
import { createMcpFlowHost } from './flow-host.js';
import type { Tool } from './types.js';
import { okResult, paginate, resolveModel } from './util.js';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';
import { resolveSafePath } from '../safe-path.js';
import type { ToolContext } from '../context.js';

const flowInputSchema = {
  flow: { description: 'Inline flow document (the parsed *.flow.json object). Provide this or flow_path.' },
  flow_path: { type: 'string', description: 'Path to a .flow.json file (subject to allowedPaths).' },
} as const;

/** Read the flow document value (object or JSON text) from `flow` / `flow_path`, whichever was given. */
async function loadFlowValue(input: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  if (input.flow !== undefined) {
    if (typeof input.flow !== 'string') return input.flow;
    try {
      return JSON.parse(input.flow);
    } catch (err) {
      throw new ToolExecutionError({ code: ToolErrorCode.PARSE_FAILED, message: `flow is not valid JSON: ${(err as Error).message}` });
    }
  }
  if (typeof input.flow_path === 'string') {
    const abs = await resolveSafePath(input.flow_path, ctx, 'read');
    const text = await readFile(abs, 'utf-8');
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new ToolExecutionError({ code: ToolErrorCode.PARSE_FAILED, message: `${input.flow_path} is not valid JSON: ${(err as Error).message}` });
    }
  }
  throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: 'Provide `flow` (inline document) or `flow_path`.' });
}

/** Structural validation only (registry-free) — `migrateFlowDocument` + `validateFlowDocument`, without `parseFlowDocument`'s string-joined throw, so callers get a `DocumentProblem[]` back instead of one opaque message. */
function parseGraphValue(value: unknown): { ok: true; doc: FlowDocument } | { ok: false; problems: readonly DocumentProblem[] } {
  const migrated = migrateFlowDocument(value);
  const problems = validateFlowDocument(migrated);
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, doc: migrated as FlowDocument };
}

const describeFlow: Tool = {
  name: 'describe_flow',
  description:
    'Describe a .flow.json graph\'s typed interface: declared inputs (name, kind, default) and outputs ' +
    '(node/port, value kind, access), plus registry-aware validation diagnostics. Never throws for an ' +
    'invalid graph — check `ok` and `diagnostics` in the result.',
  scope: 'read',
  inputSchema: { type: 'object', properties: flowInputSchema, additionalProperties: false },
  async handler(input, ctx) {
    const value = await loadFlowValue(input, ctx);
    const parsed = parseGraphValue(value);
    if (!parsed.ok) {
      return okResult(`Flow document is structurally invalid: ${parsed.problems.length} problem(s).`, {
        ok: false,
        diagnostics: parsed.problems,
      });
    }
    const registry = createStandardRegistry().registerAll(aiNodes);
    const doc = parsed.doc;
    // Registry-aware: `validateFlowDocument` alone cannot see a declared
    // output naming a port no node has (#5167) — it never looks at a
    // registry. This is what makes that defect show up here instead of
    // validating clean and producing nothing at run time.
    const diagnostics = validateFlowWiring(doc, registry);
    const io = describeFlowIO(doc, registry);
    const availability = checkAvailability(doc, registry, mcpFlowFeatures());
    const unavailable = availability.filter((node) => node.status === 'unknown' || node.status === 'unavailable');
    const ok = diagnostics.length === 0 && unavailable.length === 0;
    return okResult(
      ok
        ? `Flow '${io.name}' (${io.id}): ${io.inputs.length} input(s), ${io.outputs.length} output(s).`
        : `Flow '${io.name}' (${io.id}) has ${diagnostics.length} wiring problem(s) and ${unavailable.length} unavailable node(s).`,
      { ok, ...io, diagnostics, availability },
    );
  },
};

const DEFAULT_ROW_CAP = 1000;

function isTableValue(v: unknown): v is Table {
  return !!v && typeof v === 'object' && Array.isArray((v as Table).columns) && Array.isArray((v as Table).rows) && typeof (v as Table).key === 'string';
}

/** Bound a value before it crosses the tool-result boundary: a table's rows are capped with a truncation flag, everything else passes through (already plain data — see `values.ts`). */
function serializeCell(v: unknown): unknown {
  if (!isTableValue(v)) return v;
  const page = paginate(v.rows as unknown[], DEFAULT_ROW_CAP);
  return { columns: v.columns, key: v.key, rows: page.items, rowCount: page.total, truncated: page.truncated };
}

function serializeFlowData(data: FlowData | undefined): unknown {
  if (data === undefined) return undefined;
  switch (data.kind) {
    case 'item':
      return serializeCell(data.value);
    case 'list':
      return data.items.map(serializeCell);
    case 'group':
      return Object.fromEntries([...data.branches.entries()].map(([k, items]) => [k, items.map(serializeCell)]));
  }
}

/** Sum every tracked node's create/update/keep/remove counts — "writes" an agent decides whether to publish. */
function trackingSummary(result: RunResult): { created: number; updated: number; kept: number; removed: number } {
  let created = 0, updated = 0, kept = 0, removed = 0;
  for (const r of result.reports) {
    if (!r.tracking) continue;
    created += r.tracking.created;
    updated += r.tracking.updated;
    kept += r.tracking.kept;
    removed += r.tracking.removed;
  }
  return { created, updated, kept, removed };
}

const runFlowTool: Tool = {
  name: 'run_flow',
  description:
    'Run a .flow.json graph headlessly against a loaded model, exactly as `ifc-lite flow run` does. ' +
    '`inputs` overrides Player parameters as `{ "nodeId.param": value }`; a key naming no declared ' +
    'parameter is rejected, never silently dropped. A failed node marks the whole run failed (`ok: false`) ' +
    'and outputs downstream of it come back without data — the half-applied model is never reported as success.',
  scope: 'mutate',
  inputSchema: {
    type: 'object',
    properties: {
      ...flowInputSchema,
      checkpoint_path: { type: 'string', description: 'New durable review checkpoint destination, required before a review-capable run; subject to allowedPaths.' },
      model_id: { type: 'string', description: 'Loaded model id; required when multiple models are loaded.' },
      inputs: {
        type: 'object',
        description: 'Player parameter overrides, keyed "nodeId.param".',
        additionalProperties: true,
      },
    },
    additionalProperties: false,
  },
  handler: (input, ctx) => executeFlow(input, ctx),
};

async function executeFlow(input: Record<string, unknown>, ctx: ToolContext, resuming = false, readOnly = false) {
    const value = await loadFlowValue(input, ctx);
    const parsed = parseGraphValue(value);
    if (!parsed.ok) {
      throw new ToolExecutionError({
        code: ToolErrorCode.INVALID_INPUT,
        message: `Flow document is structurally invalid: ${parsed.problems.length} problem(s).`,
        details: { diagnostics: parsed.problems },
      });
    }
    const registry = createStandardRegistry().registerAll(aiNodes);
    const doc = parsed.doc;
    const wiring = validateFlowWiring(doc, registry);
    if (wiring.length > 0) {
      throw new ToolExecutionError({
        code: ToolErrorCode.INVALID_INPUT,
        message: `Flow document has ${wiring.length} wiring problem(s); call describe_flow first.`,
        details: { diagnostics: wiring },
      });
    }

    if (readOnly) {
      const allowed = new Set(['model.read', 'network.ai']);
      if (doc.capabilities.some(capability => !allowed.has(capability)) || doc.nodes.some(node => {
        const definition = registry.get(node.type);
        return definition?.writes || definition?.capabilities?.some(capability => !allowed.has(capability));
      })) throw new ToolExecutionError({ code: ToolErrorCode.PERMISSION_DENIED, message: 'propose_flow accepts only native read/AI nodes with model.read and network.ai; use authorized run_flow for effects' });
    }

    const rawInputs = (input.inputs as Record<string, unknown> | undefined) ?? {};
    // The CLI bug this guards against: an `--input` key naming no declared
    // parameter (e.g. missing the node id) used to be dropped silently, so
    // the graph ran on its defaults and reported success anyway (#5167).
    const unknown = unknownInputKeys(rawInputs, doc, registry);
    if (unknown.length > 0) {
      const known = declaredInputKeys(doc);
      throw new ToolExecutionError({
        code: ToolErrorCode.INVALID_INPUT,
        message: `inputs key(s) ${unknown.map((k) => `"${k}"`).join(', ')} name no declared parameter${known.length > 0 ? `; this graph declares ${known.join(', ')}` : ''}.`,
      });
    }

    // Capabilities first, so a malformed one is reported as itself rather
    // than as every secret being undeclared (#5446 review).
    const capsResult = parseCapabilities(doc.capabilities);
    if (!capsResult.ok) {
      throw new ToolExecutionError({
        code: ToolErrorCode.INVALID_INPUT,
        message: `the graph declares malformed capabilities: ${capsResult.errors.map((e) => e.message).join('; ')}`,
      });
    }

    // Secrets: validated against the real environment BEFORE anything else
    // touches the graph (see module doc above).
    const secretErrors = validateSecretReferences(doc, process.env);
    if (secretErrors.length > 0) {
      throw new ToolExecutionError({
        code: ToolErrorCode.INVALID_INPUT,
        message: `${secretErrors.length} secret reference problem(s): ${secretErrors.map((e) => e.message).join('; ')}`,
      });
    }
    const restored = await restoredMcpNodes(input, ctx, resuming);
    const unavailable = checkAvailability(doc, registry, mcpFlowFeatures())
      .filter((node) => !restored.has(node.nodeId) && (node.status === 'unknown' || node.status === 'unavailable'));
    if (unavailable.length) throw new ToolExecutionError({
      code: ToolErrorCode.UNSUPPORTED_OPERATION,
      message: `Flow cannot run on this host: ${unavailable.map((node) => `${node.nodeId}: ${node.reasons.join('; ')}`).join(' | ')}`,
      details: { availability: unavailable },
    });


    const model = resolveModel(ctx, input.model_id as string | undefined);
    const secretValues = new Map(resolveSecretValues(doc, process.env));
    const aiConfig = flowAiConfig(process.env);
    if (aiConfig) secretValues.set('IFC_LITE_AI_API_KEY', aiConfig.apiKey);
    const redaction = buildRedactionMap(secretValues);
    const runDoc = interpolateSecrets(doc, secretValues);
    const review = await prepareMcpFlowReview(input, ctx, model, runDoc, registry, rawInputs, resuming, readOnly);
    // `networkGrants` is the graph's own declared capabilities (module doc);
    // `model.openFromSource` can switch the host to a model it opened.
    const host = createMcpFlowHost(model, ctx.registry, capsResult.value, { ai: review.ai, grants: capsResult.value });
    const resume = await review.claim();
    let result: RunResult;
    try { result = await runFlow(runDoc, {
      host,
      resume,
      registry,
      inputs: rawInputs,
      features: mcpFlowFeatures(),
      modelRevisions: { [model.id]: 0 },
      tracking: new MemoryTrackingStore(),
      signal: ctx.signal,
    }); } catch (error) { await review.fail(); throw error; }
    const pending = await review.settle(result, redaction, host.defaultModelId);

    const outputs = result.graphOutputs.map((o) => ({ label: o.label, key: `${o.nodeId}.${o.port}`, data: serializeFlowData(o.data) }));
    const statuses: Record<string, number> = {};
    for (const r of result.reports) statuses[r.status] = (statuses[r.status] ?? 0) + 1;

    // Redacted at the OUTER boundary — the whole tool result, right before
    // it crosses back to the MCP client — so a secret that came back inside
    // a fetched response body (an output or an error message) is caught
    // too, not just the literal param it was interpolated into.
    return okResult(
      result.ok
        ? pending ? `Flow '${doc.name}' paused for review; no downstream effects ran.` : `Flow '${doc.name}' ran: ${outputs.length} output(s).`
        : `Flow '${doc.name}' FAILED.`,
      redactDeep(
        {
          ok: result.ok,
          usage_receipts: review.receipts,
          ...(pending ? { pending } : {}),
          nodes: statuses,
          writes: result.writes,
          tracking: trackingSummary(result),
          outputs,
          errors: result.log.filter((l) => l.level === 'error'),
          warnings: result.log.filter((l) => l.level === 'warn'),
        },
        redaction,
      ),
    );
}

const resumeFlowTool: Tool = {
  ...runFlowTool,
  name: 'resume_flow',
  description: 'Consume one separately reviewed pending Flow artifact by exact proposal digest. Rechecks current sources, graph, permissions and original budget before restoring completed nodes and running downstream effects. Completed or lost-owner claims cannot run twice.',
  inputSchema: { ...runFlowTool.inputSchema, required: ['checkpoint_path', 'approved_digest'], properties: {
    ...runFlowTool.inputSchema.properties,
    approved_digest: { type: 'string', description: 'The exact proposal_digest reviewed from the pending artifact.' },
    next_checkpoint_path: { type: 'string', description: 'A distinct new destination when downstream nodes pause for review again.' },
  } },
  handler: (input, ctx) => executeFlow(input, ctx, true),
};

const proposeFlowTool: Tool = {
  ...runFlowTool, name: 'propose_flow', scope: 'read',
  description: 'Run a native read/AI-only graph to a durable pending artifact. Model and external effect nodes are refused before requesting; applying requires a separate authorized resume_flow call.',
  handler: (input, ctx) => executeFlow(input, ctx, false, true),
};

export const flowTools: Tool[] = [describeFlow, runFlowTool, proposeFlowTool, resumeFlowTool];

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Act tools (`06-ai-agent.md` §5). `ids_apply_ops` is the ONLY way the agent
 * changes the document, and it goes through the sandbox: grounding gate,
 * then reducer, then lint. `ids_apply_fix` and an `ids_ask_user` answer
 * reuse the same path, so there is no second write path to audit.
 */

import type { ApplyOutcome, BatchSource, UnresolvedCategory } from '../sandbox/sandbox.js';
import { brief } from '../sandbox/sandbox.js';
import { diagnosticId } from '../sandbox/nodes.js';
import { objectSchema, type AgentToolContext, type IdsAgentTool } from './context.js';
import { agentOpSchema } from './op-schema.js';
import { defineTool, failure, success, type ToolOutcome } from './registry.js';
import type { JsonSchema } from '@ifc-lite/ids-authoring';

const sourceSchema: JsonSchema = objectSchema({
  opIndex: { type: 'integer', minimum: 0, description: 'The op of this batch the quote supports; omit for the whole batch.' },
  docRef: { type: 'string' },
  quote: { type: 'string', minLength: 1, description: 'The source sentence or cell, verbatim.' },
  page: { type: 'integer', minimum: 1 },
}, ['quote']);

/** Turn a sandbox outcome into the tool result the model reads. */
export function applyResult(outcome: ApplyOutcome, what: string): ToolOutcome {
  if (!outcome.applied) {
    return failure(`${what}: refused (${outcome.refusals.map((r) => r.code).join(', ')})`, {
      applied: false,
      error: 'The batch was not applied; nothing changed. Fix every issue and send the whole batch again. Pick names from "candidates" or look them up with the schema_ tools.',
      issues: outcome.refusals,
    }, outcome.refusals.map((r) => `${r.code}:${r.value ?? r.path}`));
  }
  return success(`${what}: applied ${outcome.batch.ops.length} ops as ${outcome.batch.id}`, {
    applied: true, batchId: outcome.batch.id, specIds: outcome.batch.specIds,
    ...(Object.keys(outcome.handles).length ? { handles: outcome.handles } : {}),
    diagnostics: { added: outcome.added.slice(0, 20), addedCount: outcome.added.length, resolvedCount: outcome.resolved },
  });
}

const applyOps = defineTool<{ ops: unknown[]; rationale?: string; sources?: BatchSource[] }, AgentToolContext>({
  name: 'ids_apply_ops', group: 'ids', strict: false, readOnly: false,
  description: [
    'Apply a batch of IDS operations to the working document. The batch is checked by the grounding gate first and applied all or nothing.',
    'Every IFC entity, predefined type, attribute, property set, property, data type and enumeration value must come from a schema_ or bsdd_ lookup in this run.',
    'A rejected batch returns issues with ranked candidates; nothing is applied.',
    'Name nodes you create with handles such as "@doors" (specId, facetId) and reuse the handle in later ops; opId may be omitted.',
    'Prefer one batch per specification. Attach the source sentence for each requirement in "sources".',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      ops: { type: 'array', items: agentOpSchema().op, minItems: 1 },
      rationale: { type: 'string', description: 'Why, and any assumption made.' },
      sources: { type: 'array', items: sourceSchema },
    },
    required: ['ops'],
    additionalProperties: false,
  },
  defs: agentOpSchema().defs,
  run(input, ctx) {
    const outcome = ctx.sandbox.apply(input.ops, {
      origin: 'apply_ops', ...(input.rationale ? { rationale: input.rationale } : {}), sources: input.sources ?? [],
    });
    return applyResult(outcome, 'apply_ops');
  },
});

const undo = defineTool<{ steps: number }, AgentToolContext>({
  name: 'ids_undo', group: 'ids', strict: true, readOnly: false,
  description: 'Undo the latest applied batches of this run (each batch is one step).',
  inputSchema: objectSchema({ steps: { type: 'integer', minimum: 1 } }, ['steps']),
  run(input, ctx) {
    const undone = ctx.sandbox.undo(input.steps);
    return success(`undid ${undone} batches`, { undone, remainingBatches: ctx.sandbox.batches.length });
  },
});

const lint = defineTool<{ specIds?: string[] }, AgentToolContext>({
  name: 'ids_lint', group: 'ids', strict: true, readOnly: true,
  description: 'Lint the working document. Returns diagnostics with a stable diagnosticId and the labels of the quick fixes each offers (apply one with ids_apply_fix).',
  inputSchema: objectSchema({ specIds: { type: 'array', items: { type: 'string' } } }, []),
  run(input, ctx) {
    const wanted = input.specIds && input.specIds.length > 0 ? new Set(input.specIds) : null;
    const all = ctx.sandbox.diagnostics().filter((d) => !wanted || (d.specId !== undefined && wanted.has(d.specId)));
    const order = { error: 0, warning: 1, info: 2 } as const;
    const sorted = [...all].sort((a, b) => order[a.severity] - order[b.severity]);
    return success(`${all.length} diagnostics`, {
      count: all.length,
      errors: all.filter((d) => d.severity === 'error').length,
      diagnostics: sorted.slice(0, 40).map(brief),
    });
  },
});

const applyFix = defineTool<{ diagnosticId: string; fixIndex: number }, AgentToolContext>({
  name: 'ids_apply_fix', group: 'ids', strict: true, readOnly: false,
  description: 'Apply one quick fix of a current diagnostic (diagnosticId from ids_lint or an apply result; fixIndex 0 is the first fix). Goes through the gate like ids_apply_ops.',
  inputSchema: objectSchema({ diagnosticId: { type: 'string', minLength: 1 }, fixIndex: { type: 'integer', minimum: 0 } }, ['diagnosticId', 'fixIndex']),
  run(input, ctx) {
    const d = ctx.sandbox.diagnostics().find((x) => diagnosticId(x) === input.diagnosticId);
    if (!d) return failure('unknown diagnostic', { error: `No current diagnostic has id "${input.diagnosticId}". Call ids_lint.` }, [`FIX:${input.diagnosticId}`]);
    const fix = d.fixes?.[input.fixIndex];
    if (!fix) return failure('no such fix', { error: `${d.code} offers ${d.fixes?.length ?? 0} fixes.` }, [`FIX:${input.diagnosticId}:${input.fixIndex}`]);
    const outcome = ctx.sandbox.apply(fix.ops, { origin: 'apply_fix', rationale: fix.label, sources: [], fix: { code: d.code, diagnosticId: input.diagnosticId } });
    return applyResult(outcome, `fix ${d.code}`);
  },
});

const CATEGORIES: readonly UnresolvedCategory[] = ['geometry', 'relationship', 'rules-engine', 'manual', 'ambiguous', 'out-of-scope'];

const markUnresolved = defineTool<{ statement: string; category: UnresolvedCategory; reason: string; source?: BatchSource }, AgentToolContext>({
  name: 'ids_mark_unresolved', group: 'ids', strict: true, readOnly: false,
  description: 'Record a requirement statement the IDS cannot express (geometry, relationships, counts or uniqueness belong to a rules engine), or that stays ambiguous, with the reason. Every statement must end up as ops or as unresolved.',
  inputSchema: objectSchema({
    statement: { type: 'string', minLength: 1 },
    category: { enum: CATEGORIES },
    reason: { type: 'string', minLength: 1 },
    source: sourceSchema,
  }, ['statement', 'category', 'reason']),
  run(input, ctx) {
    const item = ctx.sandbox.markUnresolved({
      statement: input.statement, category: input.category, reason: input.reason, ...(input.source ? { source: input.source } : {}),
    });
    return success(`unresolved ${item.id} (${item.category})`, { id: item.id, unresolvedCount: ctx.sandbox.unresolved.length });
  },
});

export const ACT_TOOLS: readonly IdsAgentTool[] = [applyOps, undo, lint, applyFix, markUnresolved];

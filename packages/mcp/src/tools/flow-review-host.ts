/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #7070: a durable native checkpoint is the only authority for one MCP continuation. */
import { randomUUID, createHash } from 'node:crypto';
import { stat, access } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createRootBudget, restoreRootBudget, type RootBudget } from '@ifc-lite/ai';
import { flowAiConfig } from '@ifc-lite/ai/chat-completions';
import type { FlowDocument, RunResult } from '@ifc-lite/flow';
import { approveCheckpoint, claimCheckpoint, createCheckpoint, finishCheckpoint, graphDigest,
  resumeOutputs, updateCheckpoint, recoverCheckpoint, type FlowCheckpoint } from '@ifc-lite/flow/checkpoint';
import { FileCheckpointStore } from '@ifc-lite/flow/checkpoint-file';
import { FLOW_AI_BUDGET } from '@ifc-lite/flow-nodes/ai';
import { redactDeep, buildRedactionMap, type createStandardRegistry } from '@ifc-lite/flow-nodes';
import { StepExporter } from '@ifc-lite/export';
import type { ToolContext, LoadedModel } from '../context.js';
import { scopeAllows, modelAllowed } from '../auth/scope.js';
import { resolveSafePath } from '../safe-path.js';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';
import { mcpFlowAi } from './flow-ai.js';

type Registry = ReturnType<typeof createStandardRegistry>;
const refusal = (message: string) => new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message });

/** Hash the native effective export with a fixed timestamp, including all overlay-created attributes. */
function modelDigest(model: LoadedModel): string {
  const exporter = new StepExporter(model.store, model.backend.getMutationView() ?? undefined);
  const bytes = exporter.export({ schema: model.store.schemaVersion ?? 'IFC4', timeStamp: '1970-01-01T00:00:00' }).content;
  return createHash('sha256').update(bytes).digest('hex');
}

function sourceDigest(ctx: ToolContext, model: LoadedModel): string {
  const models = ctx.registry.list().filter(item => modelAllowed(ctx.scope, item.id)).sort((a, b) => a.id.localeCompare(b.id));
  return `sha256:${createHash('sha256').update(JSON.stringify({ active: model.id, models: models.map(item => [item.id, modelDigest(item)]) })).digest('hex')}`;
}

async function unusedDestination(value: unknown, ctx: ToolContext): Promise<string> {
  if (typeof value !== 'string' || !value.trim()) throw refusal('A new checkpoint_path is required before a review-capable run');
  const path = await resolveSafePath(value, ctx, 'write');
  await access(dirname(path));
  const existing = await stat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (existing) throw refusal('A checkpoint destination must not overwrite an existing file');
  return path;
}

/** Availability must be reported before attempting model resolution, including on resume. */
export async function restoredMcpNodes(input: Record<string, unknown>, ctx: ToolContext, resuming: boolean): Promise<Set<string>> {
  if (!resuming) return new Set();
  if (typeof input.checkpoint_path !== 'string') throw refusal('Supply the pending checkpoint_path');
  const file = await resolveSafePath(input.checkpoint_path, ctx, 'read');
  return new Set(Object.keys((await new FileCheckpointStore(file).load()).checkpoint.outputs));
}

export async function prepareMcpFlowReview(input: Record<string, unknown>, ctx: ToolContext, model: LoadedModel,
  doc: FlowDocument, registry: Registry, player: Record<string, unknown>, resuming: boolean, readOnly = false) {
  const requiredScope = readOnly ? 'read' : 'mutate';
  if (!scopeAllows(ctx.scope, requiredScope)) throw new ToolExecutionError({ code: ToolErrorCode.PERMISSION_DENIED, message: `Flow execution requires the current ${requiredScope} scope` });
  let budget: RootBudget = createRootBudget(FLOW_AI_BUDGET);
  let receipts: unknown[] = [];
  let store: FileCheckpointStore | undefined;
  let checkpoint: FlowCheckpoint | undefined;
  const owner = `mcp:${process.pid}:${randomUUID()}`;
  if (resuming) {
    if (typeof input.checkpoint_path !== 'string') throw refusal('Supply the pending checkpoint_path');
    store = new FileCheckpointStore(await resolveSafePath(input.checkpoint_path, ctx, 'write'));
    checkpoint = (await store.load()).checkpoint;
    if (typeof input.approved_digest !== 'string' || input.approved_digest !== checkpoint.proposalDigest) throw refusal('Supply the exact reviewed proposal digest');
    const original = restoreRootBudget(checkpoint.budget);
    if (!original) throw refusal('Continuation requires the original root budget receipt; no new allowance can be granted');
    if (original.maxRequests > FLOW_AI_BUDGET.maxRequests || original.maxOutputTokens > FLOW_AI_BUDGET.maxOutputTokens) throw refusal('The stored budget exceeds this host policy');
    budget = original;
    const savedReceipts = (checkpoint.budget as Record<string, unknown>).usageReceipts;
    if (savedReceipts !== undefined && (!Array.isArray(savedReceipts) || savedReceipts.length > original.requests)) throw refusal('The stored usage receipts are invalid');
    receipts = Array.isArray(savedReceipts) ? [...savedReceipts] : [];
  }
  const restored = new Set(Object.keys(checkpoint?.outputs ?? {}));
  const reviewAhead = doc.nodes.some(node => !restored.has(node.id) && registry.get(node.type)?.review === 'required');
  const destination = reviewAhead ? await unusedDestination(resuming ? input.next_checkpoint_path : input.checkpoint_path, ctx) : undefined;
  // Claiming is deferred until the caller has checked wiring, capabilities, secrets and availability.
  let claimed: FlowCheckpoint | undefined;
  return {
    restored, budget, receipts, ai: mcpFlowAi(budget, receipts, () => ctx.progress.report(budget.requests, `Flow AI request ${budget.requests} of ${budget.maxRequests}`, budget.maxRequests)),
    async claim() {
      if (!store || !checkpoint) return undefined;
      const pending = store, id = checkpoint.id;
      if (recoverCheckpoint(checkpoint)) await updateCheckpoint(pending, id, current => recoverCheckpoint(current) ?? current);
      const claimInput = () => ({ owner, graphDigest: graphDigest(doc, player, registry), sourceDigest: sourceDigest(ctx, model), leaseMs: 10 * 60_000 });
      // Approval and claim are separate CAS transitions: ownership binds the actual reviewed stored record.
      if (checkpoint.state === 'prepared') await updateCheckpoint(pending, id, current => {
        const approved = current.state === 'prepared' ? approveCheckpoint(current, input.approved_digest as string) : current;
        claimCheckpoint(approved, claimInput()); // Verify sources/graph before persisting approval.
        return approved;
      });
      claimed = await updateCheckpoint(pending, id, current => claimCheckpoint(current, claimInput()));
      if (sourceDigest(ctx, model) !== claimed.sourceDigest) {
        await updateCheckpoint(pending, id, current => finishCheckpoint(current, owner, { ok: false, message: 'Sources changed while claiming' }));
        throw refusal('Sources changed while claiming; no continuation ran');
      }
      return resumeOutputs(claimed);
    },
    async settle(result: RunResult, redaction: ReadonlyMap<string, string>, activeModelId = model.id) {
      let next: FlowCheckpoint | undefined;
      try {
        if (result.ok && result.review.length) {
          if (!destination) throw refusal('No prepared destination exists for the pending artifact');
          const active = ctx.registry.get(activeModelId);
          if (!active || !modelAllowed(ctx.scope, active.id)) throw refusal('The active checkpoint model is no longer accessible');
          next = createCheckpoint({ doc, registry, result, inputs: player, sourceDigest: sourceDigest(ctx, active), budget: { ...budget, usageReceipts: receipts } });
          const config = flowAiConfig(process.env);
          const credentials = buildRedactionMap(new Map(config ? [['AI_API_KEY', config.apiKey]] : []));
          if (JSON.stringify(next) !== JSON.stringify(redactDeep(redactDeep(next, redaction), credentials))) throw refusal('The paused record contains a secret; no checkpoint can be persisted');
          if (!await new FileCheckpointStore(destination).write(next, null)) throw refusal('The pending checkpoint destination was claimed by another process');
        }
        if (store && claimed) await updateCheckpoint(store, claimed.id, current => finishCheckpoint(current, owner, { ok: result.ok }));
      } catch (error) {
        if (store && claimed) await updateCheckpoint(store, claimed.id, current => finishCheckpoint(current, owner, { ok: false, message: 'Continuation persistence failed' }));
        throw error;
      }
      return next ? { model_id: activeModelId, checkpoint_path: destination, id: next.id, state: next.state, proposal_digest: next.proposalDigest,
        artifacts: Object.fromEntries(next.reviewNodes.map(id => [id, next.outputs[id]])), budget: next.budget } : undefined;
    },
    async fail() {
      if (store && claimed) await updateCheckpoint(store, claimed.id, current => finishCheckpoint(current, owner, { ok: false, message: 'Continuation failed or was cancelled' }));
    },
  };
}

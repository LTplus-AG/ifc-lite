/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { viewerOperation, emptySchema } from './contract';
import { coordination, idSchema } from './coordination-common';
import { encodeFlowResult } from './coordination-flow';
import { coordinationOutputSchema } from './coordination-outputs';
import type { ReviewProblem } from '@/lib/flow/review-session';
import { mutationRefusal } from './mutation-refusal';
import { internal, invalidInput, parseJsonInput, stale, unavailable } from './refusals';

function checkpointRefusal(problem: ReviewProblem | null, fallback: string) {
  const message = problem?.message ?? fallback;
  if (problem?.kind === 'not-saved' || (problem?.kind === 'refused' && problem.code === 'invalid')) return internal(message);
  // The caller's digest names another proposal: re-sending it after re-inspecting cannot succeed.
  return problem?.kind === 'refused' && problem.code === 'digest-mismatch' ? invalidInput('invalid-value', message) : stale(message);
}
interface RunInput { expected_json: string; inputs_json: string; resume_checkpoint_id: string; target_model_id: string; expected_mutation_version: number; expected_geometry_version: number }
export const coordinationFlowRunOperations = [
  viewerOperation<RunInput>({ id: 'flow.run', owner: 'flow', description: 'Run the exact open native graph with its declared capabilities, provider/budget, write capture and checkpoint lifecycle. Returns completed, paused, failed or cancelled. Remote publication graphs return waiting-for-approval and require their exact native publication review; this operation never approves a proposal implicitly.',
    effects: ['read', 'configuration', 'view', 'selection', 'model', 'artifact', 'network', 'publication'], capability: 'commands-and-edits', implementation: 'native-store',
    policy: { model: 'native-reviewed', artifact: 'native-export', network: 'native-provider', publication: 'native-reviewed' }, outputSchema: coordinationOutputSchema('flow.run') }, {
    type: 'object', properties: { expected_json: { type: 'string', minLength: 1, maxLength: 1000000 }, inputs_json: { type: 'string', minLength: 2, maxLength: 500000 }, resume_checkpoint_id: { type: 'string', maxLength: 200 }, target_model_id: { type: 'string', maxLength: 200 }, expected_mutation_version: { type: 'integer', minimum: 0 }, expected_geometry_version: { type: 'integer', minimum: 0 } }, required: ['expected_json', 'inputs_json', 'resume_checkpoint_id', 'target_model_id', 'expected_mutation_version', 'expected_geometry_version'], additionalProperties: false,
  }, async (i, c) => {
    const [{ NativeFlowRunner }, { flowToJson }, { useFlowReview }, { coordinationModelAdder }, { flowRegistry, ensureFlowAiNodes }, { mutationPermission }] = await Promise.all([
      import('@/lib/flow/native-runner'), import('@/lib/flow/persistence'), import('@/lib/flow/review-session'), import('@/services/coordination-loader'), import('@/lib/flow/runner'), import('@/store/mutation-permission'),
    ]);
    const state = useViewerStore.getState(), doc = state.flowDoc;
    if ((state.activeModelId ?? '') !== i.target_model_id || state.mutationVersion !== i.expected_mutation_version || state.geometryContentVersion !== i.expected_geometry_version) throw stale('Native default model binding or source revision changed; inspect Flow state before running.');
    if (!doc || flowToJson(doc) !== i.expected_json) throw stale('The open workflow differs from the exact requested graph.');
    if (!c.host.bim) throw unavailable('This host does not expose the native viewer SDK.');
    const inputs: unknown = parseJsonInput(i.inputs_json, 'inputs_json'); if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) throw invalidInput('invalid-value', 'Player values must be a JSON object.');
    if (doc.nodes.some(node => node.type.startsWith('ai.'))) await ensureFlowAiNodes();
    const registry = flowRegistry(), { admitAgentFlowEffects } = await import('@/lib/flow/agent-effect-admission');
    const admission = admitAgentFlowEffects(doc, registry, inputs as Record<string, unknown>);
    if (admission.unknown.length) return { state: 'failed', result: null, error: `Nodes lack an explicit native automation effect contract: ${admission.unknown.join(', ')}`, checkpoint: null };
    if (admission.publication.length) return { state: 'waiting-for-approval', result: null, error: null, checkpoint: null,
      publication: { graph_id: doc.id, node_ids: admission.publication, required_action: 'Review the exact remote publication candidate in the native workflow/publication controls.' } };
    if (doc.nodes.some(node => registry.get(node.type)?.writes === 'model') || doc.capabilities.some(capability => /^model\.(mutate|create|delete)/.test(capability))) {
      const permission = mutationPermission(state, state.activeModelId ?? undefined);
      if (!permission.allowed) throw mutationRefusal(permission.reason, state.activeModelId ?? undefined);
    }
    const checkpoint = useFlowReview.getState().checkpoint;
    if (i.resume_checkpoint_id && (checkpoint?.id !== i.resume_checkpoint_id || checkpoint.state !== 'reviewed')) throw stale('Resume requires the exact native reviewed checkpoint.');
    const addModel = coordinationModelAdder(), runner = new NativeFlowRunner(c.host.bim, addModel);
    return c.commitAsync(async () => {
      if (useViewerStore.getState().flowDoc !== doc || useViewerStore.getState().models !== state.models || useViewerStore.getState().mutationVersion !== state.mutationVersion || useViewerStore.getState().geometryContentVersion !== state.geometryContentVersion || useViewerStore.getState().activeModelId !== state.activeModelId) throw stale('Workflow changed before native run admission.');
      const outcome = await runner.run(inputs as Record<string, unknown>, {
        ...(i.resume_checkpoint_id ? { resume: checkpoint! } : {}),
        expectedDefaultModelId: state.activeModelId,
      }, c.signal);
      return { ...outcome, result: encodeFlowResult(outcome.result) };
    });
  }),
  coordination('flow.review', 'Read the native paused checkpoint, exact proposal digest, review state and storage problem.', ['read'], emptySchema, async () => {
    const { useFlowReview } = await import('@/lib/flow/review-session'); const state = useFlowReview.getState(); return { checkpoint: state.checkpoint, busy: state.busy, problem: state.problem };
  }),
  coordination<{ checkpoint_id: string; proposal_digest: string }>('flow.approveReview', 'Approve only the exact native proposal digest against unchanged graph, Player values and source digests. Does not run the resumed graph.', ['configuration'], {
    type: 'object', properties: { checkpoint_id: { type: 'string', minLength: 1, maxLength: 200 }, proposal_digest: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['checkpoint_id', 'proposal_digest'], additionalProperties: false,
  }, async (i, c) => {
    const { approveReview, useFlowReview } = await import('@/lib/flow/review-session'); const doc = useViewerStore.getState().flowDoc;
    if (!doc || useFlowReview.getState().checkpoint?.id !== i.checkpoint_id) throw stale('Native review checkpoint changed.');
    return c.commitAsync(async () => { useFlowReview.setState({ problem: null }); const checkpoint = await approveReview(i.proposal_digest, doc); if (!checkpoint) throw checkpointRefusal(useFlowReview.getState().problem, 'Native checkpoint approval refused.'); return { checkpoint }; });
  }),
  coordination('flow.rejectReview', 'Reject one exact native review checkpoint without running downstream nodes.', ['configuration'], idSchema, async (i, c) => {
    const { rejectReview, useFlowReview } = await import('@/lib/flow/review-session'); if (useFlowReview.getState().checkpoint?.id !== i.id) throw stale('Native review checkpoint changed.');
    return c.commitAsync(async () => { useFlowReview.setState({ problem: null }); const checkpoint = await rejectReview(); if (!checkpoint) throw checkpointRefusal(useFlowReview.getState().problem, 'Native checkpoint rejection refused.'); return { checkpoint }; });
  }),
];

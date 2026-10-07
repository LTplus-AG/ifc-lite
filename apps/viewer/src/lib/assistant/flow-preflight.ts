/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Preflight of the open graph exactly as the Flow editor's Run would start it
 * (#6919): the same refusals as `useFlowRunner` (no model, secrets), the
 * viewer's edit permission for write nodes (which would otherwise fail every
 * write lane at run time) and the native `preflightWorkflow` under a real
 * workflow lease. Nothing runs and no
 * model is edited; the lease is released before returning, so Run remains a
 * separate explicit action in Flow.
 */

import { referencedSecrets, type FlowDocument } from '@ifc-lite/flow';
import { useViewerStore } from '@/store';
import { preflightWorkflow, isAutomationGraph } from '../flow/preflight';
import { startWorkflowRun } from '../flow/run-session';
import { flowRegistry, viewerFlowFeatures } from '../flow/runner';
import { mutationPermission, type MutationDenialReason } from '@/store/mutation-permission';
import type { TranslatableMessage, TranslationKey } from '@/i18n';

/** Viewer refusals are catalogued; native `preflightWorkflow` errors are shown verbatim through `preflightNative`. */
const DENIAL_KEY: Record<MutationDenialReason, TranslationKey> = {
  'workflow-running': 'flowAssistant.preflightDeniedWorkflow', 'edit-mode': 'flowAssistant.preflightDeniedEditMode',
  'collab-role': 'flowAssistant.preflightDeniedRole', 'model-unavailable': 'flowAssistant.preflightDeniedModel',
};
const native = (error: unknown): TranslatableMessage =>
  ({ labelKey: 'flowAssistant.preflightNative', params: { message: error instanceof Error ? error.message : String(error) } });

export interface FlowPreflightResult {
  readonly graph: FlowDocument;
  readonly ok: boolean;
  readonly problems: readonly TranslatableMessage[];
  /** Why the viewer would refuse this graph's model writes; `edit-mode` can be fixed in place. */
  readonly editDenial: MutationDenialReason | null;
}

export async function preflightOpenFlow(): Promise<FlowPreflightResult> {
  const state = useViewerStore.getState();
  const graph = state.flowDoc;
  if (!graph) throw new Error('No Flow graph is open');
  const problems: TranslatableMessage[] = [];
  if (state.flowRunning) problems.push({ labelKey: 'flowAssistant.preflightRunningWorkflow' });
  if (!state.activeModelId && !isAutomationGraph(graph)) problems.push({ labelKey: 'flowAssistant.preflightNoModel' });
  // The run itself would fail every write lane on the same policy the editor enforces.
  const writers = graph.nodes.filter(node => flowRegistry().get(node.type)?.writes === 'model').map(node => node.id);
  const permission = writers.length && state.activeModelId ? mutationPermission(state, state.activeModelId) : null;
  const editDenial = permission && !permission.allowed ? permission.reason : null;
  if (editDenial) problems.push({ labelKey: DENIAL_KEY[editDenial], params: { nodes: writers.join(', ') } });
  const secrets = [...new Set(referencedSecrets(graph).map(ref => ref.name))];
  if (secrets.length) problems.push({ labelKey: 'flowAssistant.preflightSecrets', params: { names: secrets.join(', ') } });
  if (!problems.length) {
    let session;
    try { session = startWorkflowRun(); }
    catch (error) { problems.push(native(error)); }
    if (session) {
      try {
        // The editor's Run supplies no Player values; the same empty set is checked here.
        await preflightWorkflow(session, structuredClone(graph), {}, viewerFlowFeatures(true));
      } catch (error) {
        problems.push(native(error));
      } finally {
        session.release();
      }
    }
  }
  return { graph, ok: problems.length === 0, problems, editDenial };
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { isFeatureEnabled } from '@/lib/features';
import { MemoCache, type RunResult } from '@ifc-lite/flow';
import { resumeOutputs, type FlowCheckpoint } from '@ifc-lite/flow/checkpoint';
import { useViewerStore } from '@/store';
import { captureAnalysisStamp, stampAnalysisReport } from '@/hooks/useAnalysisStaleness';
import type { FlowRunWindow } from '@/store/slices/flowSlice';
import { invalidateForExternalChange, runFlowInViewer, viewerFlowFeatures, flowRegistry } from '@/lib/flow/runner';
import { viewerTableAccess } from '@/lib/flow/viewer-tables';
import { openBackendWriteCapture } from '@/sdk/adapters/backend-write-capture';
import { createViewerOpenModel } from '@/lib/flow/open-model';
import { createAutomationHost } from '@/lib/flow/automation-host';
import { preflightWorkflow, isAutomationGraph } from '@/lib/flow/preflight';
import { startWorkflowRun } from '@/lib/flow/run-session';
import { guardAnalysisRun } from '@/hooks/analysisRunGuard';
import { writingNodes } from '@/lib/flow/publish-provenance';
import { claimReview, finishReview, pauseForReview, releaseReviewClaim, useFlowReview } from '@/lib/flow/review-session';

import type { BimContext } from '@ifc-lite/sdk';
import type { NativeModelAdder } from '@/services/coordination-loader';
export interface FlowRunOptions { readonly resume?: FlowCheckpoint; readonly expectedDefaultModelId?: string | null }
export interface NativeFlowOutcome { state: 'completed' | 'paused' | 'failed' | 'cancelled'; result: RunResult | null; error: string | null; checkpoint: FlowCheckpoint | null }
function pendingMutationIds(): Set<string> {
  return new Set([...useViewerStore.getState().undoStacks.values()].flat().map(mutation => mutation.id));
}
/** The single native orchestration for the Flow panel and viewer operations. */
export class NativeFlowRunner {
  private readonly caches = new Map<string, MemoCache>();
  private running = false;
  constructor(private readonly bim: BimContext, private readonly addModel: NativeModelAdder) {}
  invalidate(): void { if (!this.running) for (const cache of this.caches.values()) invalidateForExternalChange(this.bim, cache); }
  async run(inputs?: Record<string, unknown>, options: FlowRunOptions = {}, signal?: AbortSignal): Promise<NativeFlowOutcome> {
    const { bim, addModel } = this;
    const state = useViewerStore.getState(), { flowDoc, activeModelId, models, setFlowLastRun, setFlowRunning } = state;
    const automationGraph = flowDoc ? isAutomationGraph(flowDoc) : false;
    if (!flowDoc) return { state: 'failed', result: null, error: 'No open workflow.', checkpoint: null };
    if ((!activeModelId && !automationGraph) || this.running || useViewerStore.getState().flowRunning) return { state: 'failed', result: null, error: 'A workflow requires its native loaded model and an idle runner.', checkpoint: null };
    let session;
    try { session = startWorkflowRun(); } catch (error) {
      setFlowLastRun(null, error instanceof Error ? error.message : String(error)); return { state: 'failed', result: null, error: error instanceof Error ? error.message : String(error), checkpoint: null };
    }
    const cancel = () => session.cancel(); signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
    const doc = structuredClone(flowDoc);
    const initialDoc = flowDoc;
    // "Open file" keeps the graph (workspace state), so nothing below sees it:
    // the run generation does (A2). Cancelling only starts the drain — the
    // lease, and with it `flowRunning`, is held until the run settles.
    const guard = guardAnalysisRun(useViewerStore, () => session.cancel());
    const unsubscribe = useViewerStore.subscribe((state, previous) => {
      if (state.flowDoc !== initialDoc) session.cancel();
      if (automationGraph && !session.phase.startsWith('Loading models')
        && (state.mutationVersion !== previous.mutationVersion || state.geometryContentVersion !== previous.geometryContentVersion)) session.cancel();
      if (automationGraph && session.phase !== 'Assigning model tags'
        && (state.modelTags !== previous.modelTags || state.modelTagAssignments !== previous.modelTagAssignments)) session.cancel();
      for (const [id, model] of previous.models) {
        const current = state.models.get(id);
        if (!current || (model.ifcDataStore && current.ifcDataStore !== model.ifcDataStore)) session.cancel();
      }
    });
    session.onProgress = (phase) => useViewerStore.getState().setFlowProgress(phase);
    const heldWindow = useViewerStore.getState().flowLastRunWindow;
    useViewerStore.setState({ flowProgress: 'Checking workflow inputs', flowRunWarnings: [], flowArtifacts: [], flowLastRun: null, flowLastError: null, flowLastRunWindow: null });
    const model = activeModelId ? models.get(activeModelId) : undefined;
    const pin = model?.sourceContentHash ? `content:${model.sourceContentHash}` : `model:${activeModelId}`;
    let cache = this.caches.get(flowDoc.id);
    if (!cache) {
      cache = new MemoCache();
      this.caches.set(flowDoc.id, cache);
    }
    this.running = true;
    setFlowRunning(true);
    // Record which mutations the run itself created through `bim`, still
    // pending when it ends, so Publish takes exactly those: never an edit
    // made by hand after the run, nor one made WHILE it was in flight, which
    // goes to the store without passing the SDK backend (#5634).
    const previousWindow = options.resume && heldWindow?.checkpointId === options.resume.id ? heldWindow : null;
    const start = previousWindow?.start ?? Date.now();
    const capture = openBackendWriteCapture();
    const record = (result?: RunResult): FlowRunWindow => {
      capture.close();
      const pending = pendingMutationIds();
      // Stamped after the run's own writes: an edit made after the run makes
      // its result stale for the assistant's evidence (#6833).
      return stampAnalysisReport({
        start,
        end: Date.now(),
        doc,
        mutationIds: new Set([...(previousWindow?.mutationIds ?? []), ...capture.ids].filter((id) => pending.has(id))),
        writingNodes: result ? writingNodes(doc, flowRegistry(), result, previousWindow?.writingNodes) : previousWindow?.writingNodes ?? [],
        ...(result && result.review.length > 0 && useFlowReview.getState().checkpoint?.state === 'prepared' ? { checkpointId: useFlowReview.getState().checkpoint!.id } : {}),
      }, captureAnalysisStamp());
    };
    // Another graph opened while this one ran: its panel must not show, or
    // publish, this run (#5380 review). `openFlow` already cleared the result.
    const stillOpen = (): boolean => useViewerStore.getState().flowDoc === initialDoc;
    // ...and the session it started in is still the one on screen: a drained
    // run must not land its result or its AbortError in the next session (A2).
    const owned = (): boolean => stillOpen() && guard.isCurrent();
    const { resume, expectedDefaultModelId } = options;
    const defaultModelChanged = () =>
      expectedDefaultModelId !== undefined && useViewerStore.getState().activeModelId !== expectedDefaultModelId;
    let claimed: FlowCheckpoint | null = null, terminal: RunResult | null = null, failure: string | null = null;
    try {
      // AI nodes get the Assistant's model, spending one root budget per run; a
      // resume continues the paused run's budget, and its restored nodes need no model.
      const restored = new Set(Object.keys(resume?.outputs ?? {}));
      // A host that switched AI off (`lib/features`) gets no model: preflight then refuses AI nodes.
      const ai = isFeatureEnabled('ai.assistant') && doc.nodes.some((n) => n.type.startsWith('ai.') && !restored.has(n.id))
        ? (await import('@/lib/flow/ai-host')).viewerFlowAi(resume?.budget) : null;
      const preparedInputs = await preflightWorkflow(session, doc, inputs ?? {}, viewerFlowFeatures(true, !!ai), restored);
      session.check();
      if (defaultModelChanged()) {
        throw new Error('The default model changed during workflow preflight. Inspect Flow state before running again.');
      }
      if (resume) {
        claimed = await claimReview(doc, preparedInputs);
        if (!claimed) throw new Error('the reviewed proposal could not be resumed');
        if (defaultModelChanged()) {
          const unstarted = claimed;
          claimed = null;
          await releaseReviewClaim(unstarted);
          throw new Error('The default model changed while claiming the reviewed checkpoint.');
        }
      }
      const ownedAddModel: typeof addModel = (file, options) => addModel(file, { ...options, workflowOwner: session.id });
      const automation = createAutomationHost(session, doc, ownedAddModel, (artifact) => {
        session.check();
        const state = useViewerStore.getState();
        if (owned()) state.setFlowArtifacts([...state.flowArtifacts, artifact]);
      });
      const result = await runFlowInViewer({
        doc, bim, pin, cache, inputs: preparedInputs, signal: session.controller.signal, automation, tables: viewerTableAccess(useViewerStore),
        openModel: createViewerOpenModel(ownedAddModel),
        ...(ai ? { ai: ai.service } : {}),
        ...(claimed ? { resume: resumeOutputs(claimed) } : {}),
      });
      terminal = result;
      if (claimed) await finishReview(result);
      claimed = null;
      // A proposal awaits review: nothing downstream ran. Save it before showing the run.
      if (result.ok && result.review.length > 0) await pauseForReview({ doc, result, inputs: preparedInputs, values: inputs ?? {}, budget: ai ? { ...ai.budget } : resume?.budget });
      session.check();
      if (owned()) setFlowLastRun(result, undefined, record(result));
      else setFlowRunning(false);
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
      if (claimed) await finishReview(null, err instanceof Error ? err.message : String(err));
      if (owned()) setFlowLastRun(null, err instanceof Error ? err.message : String(err), record());
      else setFlowRunning(false);
    } finally {
      signal?.removeEventListener('abort', cancel);
      unsubscribe();
      if (owned()) useViewerStore.setState({ flowProgress: null, flowRunWarnings: [...session.warnings] });
      guard.dispose();
      if (session.controller.signal.aborted) invalidateForExternalChange(bim, cache);
      session.release();
      capture.close();
      this.running = false;
    }
    const heldCheckpoint = useFlowReview.getState().checkpoint;
    const checkpoint = heldCheckpoint?.graphId === doc.id ? heldCheckpoint : null;
    if (session.controller.signal.aborted) return { state: 'cancelled', result: terminal, error: failure, checkpoint: null };
    if (failure || !terminal?.ok) return { state: 'failed', result: terminal, error: failure ?? 'One or more native workflow nodes failed.', checkpoint: null };
    if (terminal.review.length) return { state: checkpoint?.state === 'prepared' ? 'paused' : 'failed', result: terminal,
      error: checkpoint?.state === 'prepared' ? null : useFlowReview.getState().problem?.message ?? 'Native review checkpoint was not saved.', checkpoint };
    return { state: 'completed', result: terminal, error: null, checkpoint };
  }
}

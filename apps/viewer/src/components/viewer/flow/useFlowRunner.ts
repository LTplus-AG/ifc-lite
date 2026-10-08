/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Runs the open graph against the viewer's `bim`, keeping one memo cache
 * per graph across runs and dropping it when the model changes under the
 * graph — but not on the graph's own writes, which the cache's write
 * generation already covers (events raised while a run is in flight are
 * ours).
 */

import { useCallback, useEffect, useRef } from 'react';
import { MemoCache, type RunResult } from '@ifc-lite/flow';
import { resumeOutputs, type FlowCheckpoint } from '@ifc-lite/flow/checkpoint';
import { useBim } from '@/sdk/BimProvider';
import { useIfc } from '@/hooks/useIfc';
import { useViewerStore } from '@/store';
import { captureAnalysisStamp, stampAnalysisReport } from '@/hooks/useAnalysisStaleness';
import type { FlowRunWindow } from '@/store/slices/flowSlice';
import { invalidateForExternalChange, runFlowInViewer, viewerFlowFeatures, flowRegistry } from '@/lib/flow/runner';
import { viewerTableAccess } from '@/lib/flow/viewer-tables';
import { openBackendWriteCapture } from '@/sdk/adapters/backend-write-capture';
import { createViewerOpenModel } from '@/lib/flow/open-model';
import { createAutomationHost } from '@/lib/flow/automation-host';
import { preflightWorkflow, isAutomationGraph } from '@/lib/flow/preflight';
import { startWorkflowRun, cancelWorkflowRun } from '@/lib/flow/run-session';
import { writingNodes } from '@/lib/flow/publish-provenance';
import { claimReview, finishReview, pauseForReview, useFlowReview } from '@/lib/flow/review-session';

export interface FlowRunOptions {
  /** Resume from this approved review checkpoint (#6923): its completed nodes are restored, not run again. */
  readonly resume?: FlowCheckpoint;
}

/** Ids of every pending mutation, on every model. */
function pendingMutationIds(): Set<string> {
  return new Set([...useViewerStore.getState().undoStacks.values()].flat().map((mutation) => mutation.id));
}

export function useFlowRunner(): { run: (inputs?: Record<string, unknown>, options?: FlowRunOptions) => Promise<void>; canRun: boolean; cancel: () => void } {
  const bim = useBim();
  const flowDoc = useViewerStore((s) => s.flowDoc);
  const flowRunning = useViewerStore((s) => s.flowRunning);
  const setFlowRunning = useViewerStore((s) => s.setFlowRunning);
  const setFlowLastRun = useViewerStore((s) => s.setFlowLastRun);
  const activeModelId = useViewerStore((s) => s.activeModelId);
  const models = useViewerStore((s) => s.models);
  const { addModel } = useIfc();

  const caches = useRef(new Map<string, MemoCache>());
  const running = useRef(false);

  useEffect(() => {
    const invalidate = () => {
      if (running.current) return;
      for (const cache of caches.current.values()) invalidateForExternalChange(bim, cache);
    };
    const offs = [bim.on('mutation:changed', invalidate), bim.on('model:loaded', invalidate), bim.on('model:removed', invalidate)];
    return () => { for (const off of offs) off(); };
  }, [bim]);

  const automationGraph = flowDoc ? isAutomationGraph(flowDoc) : false;
  const canRun = flowDoc !== null && !flowRunning && (activeModelId !== null || automationGraph);

  const run = useCallback(async (inputs?: Record<string, unknown>, options: FlowRunOptions = {}) => {
    if (!flowDoc || (!activeModelId && !automationGraph) || running.current || useViewerStore.getState().flowRunning) return;
    let session;
    try { session = startWorkflowRun(); } catch (error) {
      setFlowLastRun(null, error instanceof Error ? error.message : String(error)); return;
    }
    const doc = structuredClone(flowDoc);
    const initialDoc = flowDoc;
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
    let cache = caches.current.get(flowDoc.id);
    if (!cache) {
      cache = new MemoCache();
      caches.current.set(flowDoc.id, cache);
    }
    running.current = true;
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
    const { resume } = options;
    let claimed: FlowCheckpoint | null = null;
    try {
      // AI nodes get the Assistant's model, spending one root budget per run; a
      // resume continues the paused run's budget, and its restored nodes need no model.
      const restored = new Set(Object.keys(resume?.outputs ?? {}));
      const ai = doc.nodes.some((n) => n.type.startsWith('ai.') && !restored.has(n.id))
        ? (await import('@/lib/flow/ai-host')).viewerFlowAi(resume?.budget) : null;
      const preparedInputs = await preflightWorkflow(session, doc, inputs ?? {}, viewerFlowFeatures(true, !!ai), restored);
      session.check();
      if (resume) {
        claimed = await claimReview(doc, preparedInputs);
        if (!claimed) throw new Error('the reviewed proposal could not be resumed');
      }
      const ownedAddModel: typeof addModel = (file, options) => addModel(file, { ...options, workflowOwner: session.id });
      const automation = createAutomationHost(session, doc, ownedAddModel, (artifact) => {
        session.check();
        const state = useViewerStore.getState();
        if (stillOpen()) state.setFlowArtifacts([...state.flowArtifacts, artifact]);
      });
      const result = await runFlowInViewer({
        doc, bim, pin, cache, inputs: preparedInputs, signal: session.controller.signal, automation, tables: viewerTableAccess(useViewerStore),
        openModel: createViewerOpenModel(ownedAddModel, (id) => useViewerStore.getState().models.has(id)),
        ...(ai ? { ai: ai.service } : {}),
        ...(claimed ? { resume: resumeOutputs(claimed) } : {}),
      });
      if (claimed) await finishReview(result);
      claimed = null;
      // A proposal awaits review: nothing downstream ran. Save it before showing the run.
      if (result.ok && result.review.length > 0) await pauseForReview({ doc, result, inputs: preparedInputs, values: inputs ?? {}, budget: ai ? { ...ai.budget } : resume?.budget });
      session.check();
      if (stillOpen()) setFlowLastRun(result, undefined, record(result));
      else setFlowRunning(false);
    } catch (err) {
      if (claimed) await finishReview(null, err instanceof Error ? err.message : String(err));
      if (stillOpen()) setFlowLastRun(null, err instanceof Error ? err.message : String(err), record());
      else setFlowRunning(false);
    } finally {
      unsubscribe();
      if (stillOpen()) useViewerStore.setState({ flowProgress: null, flowRunWarnings: [...session.warnings] });
      if (session.controller.signal.aborted) invalidateForExternalChange(bim, cache);
      session.release();
      capture.close();
      running.current = false;
    }
  }, [flowDoc, activeModelId, models, bim, addModel, setFlowRunning, setFlowLastRun, automationGraph]);

  return { run, canRun, cancel: cancelWorkflowRun };
}

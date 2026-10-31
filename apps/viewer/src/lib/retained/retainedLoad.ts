/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The retained kernel's load policy (#7955 M2-C, spec §2.1–§2.3, §3.4):
 *
 * - scope: primary loads of IFC STEP up to `RETAINED_MAX_SOURCE_BYTES`. A
 *   federated add, any other format or an oversize source stops before any
 *   work, with a message and a Retry that switches the next load to exact;
 * - while a retained model is open, nothing is federated onto it — exact
 *   geometry never enters a retained view;
 * - no exact geometry cache read or write, no geometry server;
 * - the summary is written to the model as products arrive, and the status
 *   bar shows the retained phases;
 * - Cancel ends the run instead of discarding the load: what was published
 *   stays, every product not reached is listed `cancelled`.
 */

import { useViewerStore } from '@/store';
import { resolve as translate } from '@/i18n/registry';
import { registerEnglish, type TranslationKey } from '@/i18n';
import { retainedGeometryEn } from '@/i18n/catalogues/retained-geometry.en';
import { chooseGeometryKernel, requestedGeometryKernel } from '@/store/geometryKernel';
import { hasRetainedGeometryModel } from '@/store/retainedGeometry';
import { memoryAccounting } from '@/lib/perf/memoryAccounting';
import type { GeometryEventRequest, GeometryKernelLoad } from '@/hooks/ingest/geometryEventSource';
import { RETAINED_MAX_SOURCE_BYTES } from './retained-protocol';
import { retainedGeometryEvents, type RetainedPhase, type RetainedRunner } from './retainedGeometrySource';

registerEnglish(retainedGeometryEn);

const STEP_FILE_NAME = /\.(ifc|ifczip)$/i;
const MIB = 1024 * 1024;

function mib(bytes: number): string {
  return `${Math.ceil(bytes / MIB)} MiB`;
}

/** Reported where every load error is: the viewport error card, with Retry. */
function reportRefusal(message: string, retry: (() => void) | null): void {
  const state = useViewerStore.getState();
  state.setError(message);
  state.setLastLoadRetry(retry);
}

function refusedLoad(message: string, retry: (() => void) | null): GeometryKernelLoad {
  reportRefusal(message, retry);
  return { ...RETAINED_POLICY, refused: Promise.resolve() };
}

function phaseText(phase: RetainedPhase): { phase: string; percent: number } {
  if (phase.phase === 'starting') return { phase: translate('retainedGeometry.progress.starting'), percent: 10 };
  const { done, candidates, refused } = phase;
  return {
    phase: translate('retainedGeometry.progress.products', { done: String(done), candidates: String(candidates), refused: String(refused) }),
    percent: 10 + Math.round(85 * (candidates > 0 ? done / candidates : 1)),
  };
}

/** Shared by every retained answer: retained loads never touch exact geometry. */
const RETAINED_POLICY: GeometryKernelLoad = {
  kind: 'retained',
  serverEnabled: false,
  cachePlan: (plan) => ({ ...plan, tier: 'none', shouldCache: false }),
  refuseSource: () => true,
};

/**
 * The kernel for one load, or `null` for exact. `retry` re-runs the same load;
 * a refusal's Retry first switches the next load to the exact kernel.
 */
export function beginRetainedLoad(
  runner: RetainedRunner,
  file: File,
  target: { kind: 'primary' | 'federated' },
  retry: () => void,
): GeometryKernelLoad | null {
  const name = { file: file.name };
  if (target.kind === 'federated' && hasRetainedGeometryModel(useViewerStore.getState().models)) {
    // The open model is retained; an exact add would mix kernels in one view.
    return refusedLoad(translate('retainedGeometry.scope.federatedOnRetained', name), null);
  }
  if (requestedGeometryKernel() !== 'retained') return null;
  const exactRetry = () => { chooseGeometryKernel('exact'); retry(); };
  if (target.kind === 'federated') return refusedLoad(translate('retainedGeometry.scope.federated', name), exactRetry);
  const outOfScope = (format: string, byteLength: number): TranslationKey | null =>
    byteLength > RETAINED_MAX_SOURCE_BYTES ? 'retainedGeometry.scope.size'
      : format !== 'ifc' ? 'retainedGeometry.scope.format' : null;
  const early = outOfScope(STEP_FILE_NAME.test(file.name) ? 'ifc' : 'other', file.size);
  const message = (key: TranslationKey, byteLength: number) =>
    translate(key, { ...name, size: mib(byteLength), limit: mib(RETAINED_MAX_SOURCE_BYTES) });
  if (early) return refusedLoad(message(early, file.size), exactRetry);

  return {
    ...RETAINED_POLICY,
    refuseSource(format, byteLength, { modelId, activity }) {
      const key = outOfScope(format, byteLength);
      if (!key) return false;
      const text = activity.fail(message(key, byteLength));
      const state = useViewerStore.getState();
      state.updateModel(modelId, { loadState: 'error', loadError: text });
      state.setProgress(null);
      state.setLoading(false);
      reportRefusal(text, exactRetry);
      return true;
    },
    events: (request) => interruptible(runner, request),
  };
}

async function* interruptible(runner: RetainedRunner, request: GeometryEventRequest) {
  const state = useViewerStore.getState();
  request.activity.interrupt = () => {
    state.noteLoadCancelled();
    runner.cancel();
  };
  try {
    yield* retainedGeometryEvents(runner, request.view, {
      signal: request.signal,
      onSummary: (summary) => useViewerStore.getState().updateModel(request.modelId, { retainedGeometry: summary }),
      onPhase: (phase) => useViewerStore.getState().setProgress(phaseText(phase)),
      onWorkerMemory: (bytes) => memoryAccounting.recordWorkerMemory('retained', bytes),
    });
  } finally {
    // After the run, Cancel is the loader's again (it may still be waiting on metadata).
    request.activity.interrupt = undefined;
  }
}

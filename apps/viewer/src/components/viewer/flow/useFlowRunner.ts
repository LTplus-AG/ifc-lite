/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useMemo, useEffect, useCallback } from 'react';
import { useBim } from '@/sdk/BimProvider';
import { useIfc } from '@/hooks/useIfc';
import { useViewerStore } from '@/store';
import { NativeFlowRunner, type FlowRunOptions } from '@/lib/flow/native-runner';
import { isAutomationGraph } from '@/lib/flow/preflight';
import { cancelFlowDocumentRun } from '@/lib/flow/run-session';
export type { FlowRunOptions } from '@/lib/flow/native-runner';
/** React subscribes to the same viewer-owned state the native runner publishes. */
export function useFlowRunner(): { run: (inputs?: Record<string, unknown>, options?: FlowRunOptions) => Promise<void>; canRun: boolean; cancel: () => void } {
  const bim = useBim(), { addModel } = useIfc();
  const runner = useMemo(() => new NativeFlowRunner(bim, addModel), [bim, addModel]);
  const flowDoc = useViewerStore(state => state.flowDoc), running = useViewerStore(state => state.flowRunning), activeModelId = useViewerStore(state => state.activeModelId);
  useEffect(() => {
    const invalidate = () => runner.invalidate();
    const offs = [bim.on('mutation:changed', invalidate), bim.on('model:loaded', invalidate), bim.on('model:removed', invalidate)];
    return () => { for (const off of offs) off(); };
  }, [bim, runner]);
  const canRun = flowDoc !== null && !running && (activeModelId !== null || isAutomationGraph(flowDoc));
  const run = useCallback(async (inputs?: Record<string, unknown>, options?: FlowRunOptions) => { await runner.run(inputs, options); }, [runner]);
  return { run, canRun, cancel: cancelFlowDocumentRun };
}

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
import { MemoCache } from '@ifc-lite/flow';
import { useBim } from '@/sdk/BimProvider';
import { useViewerStore } from '@/store';
import { invalidateForExternalChange, runFlowInViewer } from '@/lib/flow/runner';
import { viewerTableAccess } from '@/lib/flow/viewer-tables';

export function useFlowRunner(): { run: (inputs?: Record<string, unknown>) => Promise<void>; canRun: boolean } {
  const bim = useBim();
  const flowDoc = useViewerStore((s) => s.flowDoc);
  const flowRunning = useViewerStore((s) => s.flowRunning);
  const setFlowRunning = useViewerStore((s) => s.setFlowRunning);
  const setFlowLastRun = useViewerStore((s) => s.setFlowLastRun);
  const activeModelId = useViewerStore((s) => s.activeModelId);
  const models = useViewerStore((s) => s.models);

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

  const canRun = flowDoc !== null && !flowRunning && activeModelId !== null;

  const run = useCallback(async (inputs?: Record<string, unknown>) => {
    if (!flowDoc || !activeModelId || running.current) return;
    const model = models.get(activeModelId);
    const pin = model?.sourceContentHash ? `content:${model.sourceContentHash}` : `model:${activeModelId}`;
    let cache = caches.current.get(flowDoc.id);
    if (!cache) {
      cache = new MemoCache();
      caches.current.set(flowDoc.id, cache);
    }
    running.current = true;
    setFlowRunning(true);
    try {
      const result = await runFlowInViewer({
        doc: flowDoc, bim, pin, cache, inputs, tables: viewerTableAccess(useViewerStore),
      });
      setFlowLastRun(result);
    } catch (err) {
      setFlowLastRun(null, err instanceof Error ? err.message : String(err));
    } finally {
      running.current = false;
    }
  }, [flowDoc, activeModelId, models, bim, setFlowRunning, setFlowLastRun]);

  return { run, canRun };
}

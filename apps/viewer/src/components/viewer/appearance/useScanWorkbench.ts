/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Intersection } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { getGlobalRenderer } from '@/hooks/useBCF';
import { createAppearancePlanner } from '@/lib/appearance/planner-worker-client';
import { prepareScanSession, type ScanSession } from '@/lib/appearance/scan/session';
import { sourceLandmark, targetLandmark } from '@/lib/appearance/scan/landmarks';
import type { ScanLandmark, ScanPair, ScanRegistrationRequest, ScanRegistrationReport } from '@/lib/appearance/scan/types';
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function useScanWorkbench() {
  const models = useViewerStore(s => s.models), mutationVersion = useViewerStore(s => s.mutationVersion);
  const placement = useViewerStore(s => s.modelPlacement), room = useViewerStore(s => s.collabRoomId);
  const sources = useMemo(() => [...models.values()].filter(model => /\.glb$/i.test(model.sourceFile?.name ?? '')).flatMap(model =>
    (model.geometryResult?.meshes ?? []).flatMap((mesh, index) => mesh.textureRef && mesh.uvs ? [{ id: `${model.id}:${index}`, modelId: model.id, index, label: `${model.name} · Surface ${index + 1}` }] : [])), [models]);
  const targets = [...models.values()].filter(model => model.ifcDataStore && !/\.glb$/i.test(model.sourceFile?.name ?? '') && useViewerStore.getState().mutationViews.has(model.id));
  const [sourceId, setSourceId] = useState(''), [targetId, setTargetId] = useState(''), [restart, setRestart] = useState(0);
  const [session, setSession] = useState<ScanSession | null>(null), [pairs, setPairs] = useState<ScanPair[]>([]);
  const [partition, setPartition] = useState<'fit' | 'check'>('fit');
  const [pending, setPending] = useState<{ point: ScanLandmark; partition: 'fit' | 'check' } | null>(null);
  const [result, setResult] = useState<{ request: ScanRegistrationRequest; report: ScanRegistrationReport } | null>(null);
  const [busy, setBusy] = useState(false), [stale, setStale] = useState(false), [previewReady, setPreviewReady] = useState(false);
  const [status, setStatus] = useState('Open a textured GLB and an IFC model to align a scan.'), [error, setError] = useState(false), [aligned, setAligned] = useState(false);
  const planner = useRef<ReturnType<typeof createAppearancePlanner> | null>(null), operation = useRef<AbortController | null>(null);
  const rows = useRef(pairs); rows.current = pairs;
  useEffect(() => { const p = createAppearancePlanner(); planner.current = p; return () => { operation.current?.abort(); p.dispose(); planner.current = null; }; }, []);
  useEffect(() => { if (!sourceId && sources[0]) setSourceId(sources[0].id); if (!targetId && targets[0]) setTargetId(targets[0].id); }, [sources, targets, sourceId, targetId]);
  useEffect(() => {
    const source = sources.find(item => item.id === sourceId);
    const controller = new AbortController(); operation.current?.abort(); planner.current?.cancel(); operation.current = controller;
    setSession(null); setPending(null); setPairs([]); setResult(null); setAligned(false); setStale(false); setError(false);
    if (!source || !models.has(targetId)) { setBusy(false); setStatus('Choose a loaded scan surface and IFC model.'); return () => controller.abort(); }
    setBusy(true); setStatus('Preparing source and IFC coordinate frames…');
    void prepareScanSession(source.modelId, source.index, targetId, controller.signal).then(prepared => {
      if (controller.signal.aborted) return; setSession(prepared); setStatus('Click a landmark on the scan preview, then its matching IFC point in the main view.');
    }).catch(failure => { if (!controller.signal.aborted) { setError(true); setStatus(message(failure)); } }).finally(() => { if (!controller.signal.aborted) setBusy(false); if (operation.current === controller) operation.current = null; });
    return () => controller.abort();
    // Model/frame changes invalidate the pinned session below; they never replace its source silently.
  }, [sourceId, targetId, restart]);
  useEffect(() => {
    if (!session) return;
    try { session.validate(); } catch (failure) { operation.current?.abort(); planner.current?.cancel(); setBusy(false); setStale(true); setPending(null); setResult(null); setAligned(false); setError(true); setStatus(message(failure)); }
  }, [session, models, mutationVersion, placement, room]);
  useEffect(() => {
    if (!pending || !session || stale) return;
    const renderer = getGlobalRenderer(); if (!renderer) { setError(true); setStatus('The main view is not ready. Cancel this point and retry once the IFC is visible.'); return; }
    const canvas = renderer.getCanvas();
    let down: { x: number; y: number; id: number } | null = null;
    const start = (event: PointerEvent) => { if (event.button !== 0) return; down = { x: event.clientX, y: event.clientY, id: event.pointerId }; };
    const pick = (event: PointerEvent) => {
      if (!down || down.id !== event.pointerId || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4) return;
      down = null; event.preventDefault(); event.stopImmediatePropagation();
      try {
        const rect = canvas.getBoundingClientRect(), target = targetLandmark(session, renderer, event.clientX - rect.left, event.clientY - rect.top);
        const existing = rows.current;
        if (existing.some(row => row.correspondence.sourceObservation === pending.point.observation || row.correspondence.targetFeature === target.feature)) throw new Error('That landmark is already paired. Choose an independent point.');
        if (existing.filter(row => row.partition === pending.partition).length >= 256) throw new Error('Each fit/check set is limited to 256 pairs.');
        const row: ScanPair = { source: pending.point, partition: pending.partition, correspondence: { id: crypto.randomUUID(), sourceObservation: pending.point.observation, targetFeature: target.feature, source: pending.point.point, target: target.point } };
        setPairs(previous => [...previous, row]); setPending(null); setResult(null); setAligned(false); setError(false); setStatus('Pair added. Pick another landmark, or calculate the alignment.');
      } catch (failure) { setError(true); setStatus(message(failure)); }
    };
    canvas.addEventListener('pointerdown', start, true); canvas.addEventListener('pointerup', pick, true);
    return () => { canvas.removeEventListener('pointerdown', start, true); canvas.removeEventListener('pointerup', pick, true); };
  }, [pending, session, stale]);
  function pickSource(hit: Intersection) {
    if (!session || stale || busy || aligned) return;
    try { session.validate(); setPending({ point: sourceLandmark(session.source, hit, session.sourceMeshOrdinal), partition }); setError(false); setStatus('Now click the matching visible surface point in the chosen IFC model. Drag the main view to orbit if needed.'); }
    catch (failure) { setError(true); setStatus(message(failure)); }
  }
  async function calculate() {
    if (!session || !planner.current || busy || stale) return;
    const controller = new AbortController(); operation.current = controller;
    setBusy(true); setError(false); setStatus('Calculating rigid alignment and independent check errors…'); setPending(null);
    try {
      session.validate();
      const request: ScanRegistrationRequest = structuredClone({ sourceFrame: session.sourceFrame, targetFrame: session.targetFrame, fit: pairs.filter(p => p.partition === 'fit').map(p => p.correspondence), heldOut: pairs.filter(p => p.partition === 'check').map(p => p.correspondence) });
      const report = await planner.current.registerScan(request, { signal: controller.signal });
      controller.signal.throwIfAborted(); session.validate(); setResult({ request, report }); setStatus('Review the fit and independent checks. No accuracy approval is inferred from a successful solve.');
    } catch (failure) { if (!controller.signal.aborted) { setError(true); setStatus(message(failure)); } }
    finally { if (operation.current === controller) { operation.current = null; setBusy(false); } }
  }
  function cancel() { if (!session) setStale(true); operation.current?.abort(); planner.current?.cancel(); setPending(null); setBusy(false); setStatus('Alignment operation cancelled. Existing pairs are retained.'); }
  return { sources, targets, sourceId, targetId, setSourceId, setTargetId, session, pairs, partition, setPartition, pending, result,
    busy, stale, previewReady, setPreviewReady, status, error, aligned, setAligned, pickSource, calculate, cancel,
    restart() { setRestart(value => value + 1); },
    remove(id: string) { setPairs(previous => previous.filter(p => p.correspondence.id !== id)); setResult(null); setAligned(false); },
    changePartition(id: string, value: 'fit' | 'check') { setPairs(previous => previous.map(p => p.correspondence.id === id ? { ...p, partition: value } : p)); setResult(null); setAligned(false); },
    previewError(value: string) { setError(true); setStatus(value); setPreviewReady(false); },
  };
}

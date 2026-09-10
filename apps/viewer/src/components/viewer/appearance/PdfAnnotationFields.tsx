/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useViewerStore } from '@/store';
import { getGlobalRenderer } from '@/hooks/useBCF';
import { preparePdfReferenceAnnotation, type PreparedPdfReferenceAnnotation } from '@/lib/appearance/pdf/prepare-reference-annotation';
import { AppearanceMeshPreview } from './AppearanceMeshPreview';
import { selectCreatedAppearanceObject } from './select-created-object';

const ignoreRegion = () => {};
export function PdfAnnotationFields({ referenceId, modelId, containerId, Name, disabled }: {
  referenceId: string; modelId: string; containerId?: number; Name: string; disabled: boolean;
}) {
  const [tolerance, setTolerance] = useState('0.001');
  const [prepared, setPrepared] = useState<PreparedPdfReferenceAnnotation | null>(null);
  const retained = useRef<PreparedPdfReferenceAnnotation | null>(null);
  const operation = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false), [ready, setReady] = useState(false);
  const [message, setMessage] = useState(''), [error, setError] = useState(false);
  const models = useViewerStore(state => state.models), references = useViewerStore(state => state.appearanceReferences);
  const version = useViewerStore(state => state.mutationVersion), placement = useViewerStore(state => state.modelPlacement);
  const room = useViewerStore(state => state.collabRoomId);
  const drop = () => { retained.current?.dispose(); retained.current = null; setPrepared(null); setReady(false); };
  useEffect(() => {
    operation.current?.abort(); operation.current = null; setBusy(false); drop(); setError(false); setMessage('');
  }, [referenceId, modelId, containerId, Name, tolerance]);
  useEffect(() => () => { operation.current?.abort(); operation.current = null; retained.current?.dispose(); retained.current = null; }, []);
  useEffect(() => {
    if (disabled || room) { operation.current?.abort(); operation.current = null; setBusy(false); drop(); return; }
    if (operation.current) return; // The command validates its own asynchronous publication fence.
    try { retained.current?.validate(); }
    catch (failure) { drop(); setError(true); setMessage(failure instanceof Error ? failure.message : String(failure)); }
  }, [disabled, room, models, references, version, placement]);
  const triangles = useMemo(() => prepared ? Array.from({ length: prepared.meshes[0].indices.length / 3 }, (_, i) => i) : [], [prepared]);
  const additionalMeshes = useMemo(() => prepared?.meshes.slice(1) ?? [], [prepared]);
  const metricTolerance = Number(tolerance);
  const valid = !!modelId && containerId !== undefined && !!Name.trim() && tolerance.trim() !== ''
    && Number.isFinite(metricTolerance) && metricTolerance > 0 && metricTolerance <= 0.1;
  async function prepare() {
    if (!valid || disabled || room || operation.current || containerId === undefined) return;
    drop(); const controller = new AbortController(); operation.current = controller;
    setBusy(true); setError(false); setMessage('Checking original PDF vectors and preparing geometry…');
    try {
      const result = await preparePdfReferenceAnnotation(modelId, containerId, referenceId, { Name, toleranceMetres: metricTolerance, signal: controller.signal });
      if (controller.signal.aborted || operation.current !== controller) { result.dispose(); return; }
      try { result.validate(); } catch (failure) { result.dispose(); throw failure; }
      retained.current = result; setPrepared(result);
      setMessage(`Review ${result.regions} coloured regions. The original drawing remains available.`);
    } catch (failure) {
      if (!controller.signal.aborted && operation.current === controller) { setError(true); setMessage(failure instanceof Error ? failure.message : String(failure)); }
    } finally { if (operation.current === controller) { operation.current = null; setBusy(false); } }
  }
  async function create() {
    const result = retained.current, renderer = getGlobalRenderer();
    if (!result || !ready || busy || disabled || room) return;
    if (!renderer) { setError(true); setMessage('Wait for the 3D view to be ready.'); return; }
    const controller = new AbortController(); operation.current = controller;
    setBusy(true); setError(false); setMessage('Creating PDF annotation…');
    try {
      const created = await result.create(renderer, { signal: controller.signal });
      if (controller.signal.aborted || operation.current !== controller) return;
      selectCreatedAppearanceObject(modelId, created); drop();
      setMessage('PDF IfcAnnotation created and selected. Hide the drawing above to inspect it. Undo is available.');
    } catch (failure) {
      if (!controller.signal.aborted && operation.current === controller) { drop(); setError(true); setMessage(failure instanceof Error ? failure.message : String(failure)); }
    } finally { if (operation.current === controller) { operation.current = null; setBusy(false); } }
  }
  return <div className="space-y-2" aria-busy={busy}>
    <p className="text-[11px] text-muted-foreground">Convert supported fills and straight strokes into coloured IFC geometry. Text, images and unsupported paint effects need the Image option. User-cropped pages are not yet supported.</p>
    <label className="block text-[11px]">Geometry tolerance (m)<Input aria-label="PDF geometry tolerance (m)" value={tolerance} disabled={busy || disabled}
      onChange={event => setTolerance(event.target.value)} className="h-8 text-xs" /></label>
    <Button type="button" variant="outline" size="sm" disabled={!valid || busy || disabled || !!room} onClick={() => { void prepare(); }}>Prepare vector preview</Button>
    {prepared && <>
      <AppearanceMeshPreview mesh={prepared.meshes[0]} additionalMeshes={additionalMeshes} initialPlane={prepared.initialPlane} triangles={triangles} disabled={busy || disabled}
        regionControls={false} onRegion={ignoreRegion} onReady={setReady} onError={value => { setError(true); setMessage(value); }}
        canvasLabel="PDF annotation geometry preview" instruction="Exact native vector geometry. Drag to orbit; scroll to zoom. Colours and empty regions are retained." />
      <Button type="button" size="sm" disabled={!ready || busy || disabled || !!room} onClick={() => { void create(); }}>Create annotation</Button>
    </>}
    {busy && <Button type="button" size="sm" variant="ghost" onClick={() => {
      operation.current?.abort(); operation.current = null; setBusy(false); drop(); setError(false); setMessage('PDF annotation preparation cancelled.');
    }}>Cancel</Button>}
    {message && <p role={error ? 'alert' : 'status'} className={`text-[11px] ${error ? 'text-destructive' : 'text-muted-foreground'}`}>{message}</p>}
  </div>;
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useViewerStore } from '@/store';
import { getGlobalRenderer } from '@/hooks/useBCF';
import { checkPdfReferenceVectors, type PdfReferenceVectorCheck, type PreparedPdfReferenceAnnotation } from '@/lib/appearance/pdf/prepare-reference-annotation';
import type { PdfFidelityReport } from '@/lib/appearance/pdf/vector-types';
import { AppearanceMeshPreview } from './AppearanceMeshPreview';
import { PdfFidelityReportView, visibleOmissionCount } from './PdfFidelityReportView';
import { selectCreatedAppearanceObject } from './select-created-object';

const ignoreRegion = () => {};
/** Fidelity-gated conversion (#4406): the canonical report decides whether the
 * page converts exactly. A partial page needs explicit acceptance of the listed
 * omissions before geometry is prepared; a raster-only page never converts. */
export function PdfAnnotationFields({ referenceId, modelId, containerId, Name, disabled }: {
  referenceId: string; modelId: string; containerId?: number; Name: string; disabled: boolean;
}) {
  const [tolerance, setTolerance] = useState('0.001');
  const [report, setReport] = useState<{ verdict: PdfFidelityReport; userUnit: number } | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [prepared, setPrepared] = useState<PreparedPdfReferenceAnnotation | null>(null);
  const check = useRef<PdfReferenceVectorCheck | null>(null);
  const retained = useRef<PreparedPdfReferenceAnnotation | null>(null);
  const operation = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false), [ready, setReady] = useState(false);
  const [message, setMessage] = useState(''), [error, setError] = useState(false);
  const models = useViewerStore(state => state.models), references = useViewerStore(state => state.appearanceReferences);
  const version = useViewerStore(state => state.mutationVersion), placement = useViewerStore(state => state.modelPlacement);
  const room = useViewerStore(state => state.collabRoomId);
  const cancel = () => { operation.current?.abort(); operation.current = null; setBusy(false); };
  const dropPrepared = () => { retained.current = null; setPrepared(null); setReady(false); };
  const dropAll = () => { dropPrepared(); check.current?.dispose(); check.current = null; setReport(null); setAccepted(false); };
  // The report binds the original page and metric tolerance; the IFC target and Name bind only the prepared plan.
  useEffect(() => { cancel(); dropAll(); setError(false); setMessage(''); }, [referenceId, tolerance]);
  useEffect(() => { cancel(); dropPrepared(); setError(false); setMessage(''); }, [modelId, containerId, Name]);
  useEffect(() => () => { cancel(); dropAll(); }, []);
  useEffect(() => {
    if (disabled || room) { cancel(); dropAll(); return; }
    if (operation.current) return; // The command validates its own asynchronous publication fence.
    try { retained.current?.validate(); check.current?.validate(); }
    catch (failure) { dropAll(); setError(true); setMessage(failure instanceof Error ? failure.message : String(failure)); }
  }, [disabled, room, models, references, version, placement]);
  const triangles = useMemo(() => prepared ? Array.from({ length: prepared.meshes[0].indices.length / 3 }, (_, i) => i) : [], [prepared]);
  const additionalMeshes = useMemo(() => prepared?.meshes.slice(1) ?? [], [prepared]);
  const metricTolerance = Number(tolerance);
  const valid = !!modelId && containerId !== undefined && !!Name.trim() && tolerance.trim() !== ''
    && Number.isFinite(metricTolerance) && metricTolerance > 0 && metricTolerance <= 0.1;
  const partial = !!report && !report.verdict.exact && !report.verdict.rasterOnly;
  async function prepare() {
    if (!valid || disabled || room || operation.current || containerId === undefined) return;
    dropPrepared(); const controller = new AbortController(); operation.current = controller;
    setBusy(true); setError(false); setMessage('Checking original PDF vectors…');
    try {
      let current = check.current;
      if (!current) {
        current = await checkPdfReferenceVectors(referenceId, { toleranceMetres: metricTolerance, signal: controller.signal });
        if (controller.signal.aborted || operation.current !== controller) { current.dispose(); return; }
        try { current.validate(); } catch (failure) { current.dispose(); throw failure; }
        check.current = current; setReport({ verdict: current.report, userUnit: current.page.userUnit });
      }
      const verdict = current.report;
      if (verdict.rasterOnly) { setError(true); setMessage('This page has no vector drawing content. Keep it as a raster reference and use the Image representation.'); return; }
      if (!verdict.exact && !accepted) {
        const n = visibleOmissionCount(verdict);
        setMessage(`Partial conversion: ${n} visible ${n === 1 ? 'omission' : 'omissions'}. Review the report and accept the partial conversion to prepare it.`); return;
      }
      setMessage('Preparing geometry…');
      const result = await current.prepare(modelId, containerId, { Name, acceptPartial: accepted, signal: controller.signal });
      if (controller.signal.aborted || operation.current !== controller) return;
      result.validate();
      retained.current = result; setPrepared(result);
      setMessage(`Review ${result.regions} coloured regions${verdict.exact ? '' : ' of the accepted partial conversion'}. The original drawing remains available.`);
    } catch (failure) {
      if (!controller.signal.aborted && operation.current === controller) { setError(true); setMessage(failure instanceof Error ? failure.message : String(failure)); }
    } finally { if (operation.current === controller) { operation.current = null; setBusy(false); } }
  }
  async function create() {
    const result = retained.current, renderer = getGlobalRenderer(), exact = !!report?.verdict.exact;
    if (!result || !ready || busy || disabled || room) return;
    if (!renderer) { setError(true); setMessage('Wait for the 3D view to be ready.'); return; }
    const controller = new AbortController(); operation.current = controller;
    setBusy(true); setError(false); setMessage('Creating PDF annotation…');
    try {
      const created = await result.create(renderer, { signal: controller.signal });
      if (controller.signal.aborted || operation.current !== controller) return;
      selectCreatedAppearanceObject(modelId, created); dropAll();
      setMessage(exact ? 'PDF IfcAnnotation created and selected. Hide the drawing above to inspect it. Undo is available.'
        : 'Partial PDF IfcAnnotation created and selected; the accepted omissions are recorded in its IfcLite_PdfVectorConversion property set. Undo is available.');
    } catch (failure) {
      if (!controller.signal.aborted && operation.current === controller) { dropAll(); setError(true); setMessage(failure instanceof Error ? failure.message : String(failure)); }
    } finally { if (operation.current === controller) { operation.current = null; setBusy(false); } }
  }
  return <div className="space-y-2" aria-busy={busy}>
    <p className="text-[11px] text-muted-foreground">Convert supported fills and straight strokes into coloured IFC geometry. Curves are flattened within the tolerance below, measured in model metres after calibration. The page is checked first: text, images, clipping, transparency, patterns and other unsupported paint are reported, never silently dropped. User-cropped pages are not yet supported.</p>
    <label className="block text-[11px]">Geometry tolerance (m)<Input aria-label="PDF geometry tolerance (m)" value={tolerance} disabled={busy || disabled}
      onChange={event => setTolerance(event.target.value)} className="h-8 text-xs" /></label>
    {report && <PdfFidelityReportView report={report.verdict} userUnit={report.userUnit} />}
    {partial && <label className="flex items-start gap-1.5 text-[11px]"><input type="checkbox" aria-label="Accept partial PDF conversion" className="mt-0.5" checked={accepted} disabled={busy || disabled}
      onChange={event => { setAccepted(event.target.checked); dropPrepared(); }} />Create a partial conversion. The omissions listed above are left out and recorded with the annotation.</label>}
    <Button type="button" variant="outline" size="sm" disabled={!valid || busy || disabled || !!room || !!report?.verdict.rasterOnly || (partial && !accepted)} onClick={() => { void prepare(); }}>
      {partial ? 'Prepare partial conversion' : 'Prepare vector preview'}</Button>
    {prepared && <>
      <AppearanceMeshPreview mesh={prepared.meshes[0]} additionalMeshes={additionalMeshes} initialPlane={prepared.initialPlane} triangles={triangles} disabled={busy || disabled}
        regionControls={false} onRegion={ignoreRegion} onReady={setReady} onError={value => { setError(true); setMessage(value); }}
        canvasLabel="PDF annotation geometry preview" instruction="Exact native vector geometry. Drag to orbit; scroll to zoom. Colours and empty regions are retained." />
      <Button type="button" size="sm" disabled={!ready || busy || disabled || !!room} onClick={() => { void create(); }}>Create annotation</Button>
    </>}
    {busy && <Button type="button" size="sm" variant="ghost" onClick={() => { cancel(); dropAll(); setError(false); setMessage('PDF annotation preparation cancelled.'); }}>Cancel</Button>}
    {message && <p role={error ? 'alert' : 'status'} className={`text-[11px] ${error ? 'text-destructive' : 'text-muted-foreground'}`}>{message}</p>}
  </div>;
}

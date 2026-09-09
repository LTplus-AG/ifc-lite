/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { alignedScanPreview, scanPreviewPoint } from '@/lib/appearance/scan/preview';
import { CapturePreview } from './CapturePreview';
import { useScanWorkbench } from './useScanWorkbench';
const ignoreRegion = () => {};
const metres = (value: number | null) => value === null ? '—' : `${value.toPrecision(3)} m`;

/** Correspondence review owns a preview only; the loaded scan is never moved. */
export function AppearanceScanPanel() {
  const work = useScanWorkbench();
  const report = work.result?.report;
  const mesh = useMemo(() => work.session && (work.aligned && report ? alignedScanPreview(work.session.source, report) : work.session.source), [work.session, work.aligned, report]);
  const triangles = useMemo(() => mesh ? Array.from({ length: mesh.indices.length / 3 }, (_, index) => index) : [], [mesh]);
  const fit = work.pairs.filter(pair => pair.partition === 'fit').length;
  const checks = work.pairs.length - fit;
  const markers = useMemo(() => work.pairs.flatMap((pair, index) => {
    const point = pair.source.point;
    const origin = work.session?.source.origin ?? [0, 0, 0];
    const source = work.aligned && report ? scanPreviewPoint(report, point, true) : { x: point[0] - origin[0], y: point[1] - origin[1], z: point[2] - origin[2] };
    const marker = { id: `P${index + 1}`, point: source, check: pair.partition === 'check' };
    return work.aligned && report ? [marker, { id: `IFC ${index + 1}`, point: scanPreviewPoint(report, pair.correspondence.target, false), check: true }] : [marker];
  }), [work.pairs, work.session, work.aligned, report]);
  return <section className="space-y-3 pt-4" aria-label="Scan alignment" aria-busy={work.busy}>
    <div><h2 className="text-sm font-semibold">Align scan</h2><p className="mt-1 text-xs text-muted-foreground">Match scan landmarks to IFC surfaces, then review the alignment and independent checks.</p></div>
    <label className="block text-xs">Scan surface<select className="mt-1 w-full rounded border bg-background p-2" value={work.sourceId} disabled={work.busy} onChange={event => work.setSourceId(event.target.value)}><option value="">Choose a textured GLB surface</option>{work.sources.map(source => <option key={source.id} value={source.id}>{source.label}</option>)}</select></label>
    <label className="block text-xs">IFC model<select className="mt-1 w-full rounded border bg-background p-2" value={work.targetId} disabled={work.busy} onChange={event => work.setTargetId(event.target.value)}><option value="">Choose an IFC model</option>{work.targets.map(target => <option key={target.id} value={target.id}>{target.name}</option>)}</select></label>
    {mesh && work.session && <CapturePreview mesh={mesh} assetId={work.session.assetId} triangles={triangles} disabled={work.busy || work.stale} regionControls={false} onRegion={ignoreRegion} onReady={work.setPreviewReady} onError={work.previewError} onLandmark={work.pickSource} markers={markers} canvasLabel="Scan landmark preview" instruction={work.aligned ? 'Aligned preview. P marks scan landmarks; IFC marks their target positions.' : 'Click a scan landmark, then its matching point in the main IFC view. Drag to orbit; scroll to zoom.'} />}
    <div role="group" aria-label="Landmark purpose" className="grid grid-cols-2 gap-2">
      <Button size="sm" variant={work.partition === 'fit' ? 'secondary' : 'outline'} aria-pressed={work.partition === 'fit'} disabled={work.busy || work.aligned} onClick={() => work.setPartition('fit')}>Fit · {fit}</Button>
      <Button size="sm" variant={work.partition === 'check' ? 'secondary' : 'outline'} aria-pressed={work.partition === 'check'} disabled={work.busy || work.aligned} onClick={() => work.setPartition('check')}>Check · {checks}</Button>
    </div>
    <p className="text-xs text-muted-foreground">Spread fit points across the scan. Choose check points independently: they measure error without influencing the fit. Review at least four of each before using this alignment.</p>
    {work.pairs.length > 0 && <ol className="max-h-48 space-y-1 overflow-y-auto" aria-label="Landmark pairs">{work.pairs.map((pair, index) => {
      const residual = (pair.partition === 'fit' ? report?.fit : report?.heldOut)?.points.find(point => point.id === pair.correspondence.id);
      return <li key={pair.correspondence.id} className="flex items-center gap-2 text-xs"><span>P{index + 1}</span><select aria-label={`Purpose of P${index + 1}`} value={pair.partition} disabled={work.busy} onChange={event => work.changePartition(pair.correspondence.id, event.target.value === 'fit' ? 'fit' : 'check')} className="rounded border bg-background p-1"><option value="fit">Fit</option><option value="check">Check</option></select><span className="flex-1">{residual ? metres(residual.distanceMetres) : 'Not measured'}</span><Button variant="ghost" size="sm" disabled={work.busy} aria-label={`Remove P${index + 1}`} onClick={() => work.remove(pair.correspondence.id)}>Remove</Button></li>;
    })}</ol>}
    {report && <div className="space-y-1 rounded border p-2 text-xs" aria-label="Alignment results"><p>Fit RMS {metres(report.fit.rmsMetres)} · maximum {metres(report.fit.maxMetres)}</p><p>Check RMS {metres(report.heldOut.rmsMetres)} · maximum {metres(report.heldOut.maxMetres)}</p><p>Fit coverage ratio {report.sourceSpread.nonCollinearityRatio.toPrecision(3)}. Nearly collinear landmarks are unreliable.</p>{report.diagnostics.map(diagnostic => <p key={diagnostic}>{diagnostic}</p>)}<p>Inspect individual errors against your project tolerance. The scan and IFC have not been changed.</p></div>}
    <p role={work.error ? 'alert' : 'status'} aria-live="polite" className={`text-xs ${work.error ? 'text-destructive' : 'text-muted-foreground'}`}>{work.status}</p>
    <div className="flex flex-wrap gap-2">
      {(work.busy || work.pending) && <Button size="sm" variant="outline" onClick={work.cancel}>Cancel</Button>}
      {(work.stale || (work.error && !work.session)) && <Button size="sm" variant="outline" onClick={work.restart}>Restart with current models</Button>}
      <Button size="sm" disabled={!work.session || !work.previewReady || work.busy || work.stale || fit < 3} onClick={() => void work.calculate()}>Calculate alignment</Button>
      {report && <Button size="sm" variant="outline" disabled={work.busy || work.stale || !work.previewReady} aria-pressed={work.aligned} onClick={() => work.setAligned(!work.aligned)}>{work.aligned ? 'Return to landmarks' : 'Preview alignment'}</Button>}
    </div>
  </section>;
}

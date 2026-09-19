/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { alignedScanPreview, scanPreviewPoint } from '@/lib/appearance/scan/preview';
import { sourceLandmark } from '@/lib/appearance/scan/landmarks';
import { alignedPointPreview, pointLandmark, pointPreviewPosition } from '@/lib/appearance/scan/point-source';
import { AppearanceMeshPreview } from './AppearanceMeshPreview';
import { AppearancePointPreview } from './AppearancePointPreview';
import { ScanTransferFields } from './ScanTransferFields';
import { useScanTransfer } from './useScanTransfer';
import { useScanWorkbench } from './useScanWorkbench';
import { useTranslation, type TranslationKey, type TranslationParameters } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
const ignoreRegion = () => {};
/** `t` is threaded in explicitly: this is a plain (non-component) helper, so
 *  it cannot call the `useTranslation` hook itself. */
const metres = (value: number | null, locale: string, t: (key: TranslationKey, params?: TranslationParameters) => string) =>
  value === null ? t('appearance.scan.metresEmpty') : t('appearance.scan.metresValue', {
    value: formatLocaleNumber(locale, value, { minimumSignificantDigits: 3, maximumSignificantDigits: 3 }),
  });

/** Correspondence review owns a preview only; the loaded scan is never moved. */
export function AppearanceScanPanel() {
  const { t, locale } = useTranslation();
  const work = useScanWorkbench();
  const transfer = useScanTransfer(work);
  const report = work.result?.report;
  const meshSource = work.session?.source.kind === 'mesh' ? work.session.source : null;
  const pointSource = work.session?.source.kind === 'points' ? work.session.source.points : null;
  const mesh = useMemo(() => meshSource && (work.aligned && report ? alignedScanPreview(meshSource.mesh, report) : meshSource.mesh), [meshSource, work.aligned, report]);
  const points = useMemo(() => pointSource && (work.aligned && report ? alignedPointPreview(pointSource, report) : pointSource.positions), [pointSource, work.aligned, report]);
  const triangles = useMemo(() => mesh ? Array.from({ length: mesh.indices.length / 3 }, (_, index) => index) : [], [mesh]);
  const fit = work.pairs.filter(pair => pair.partition === 'fit').length;
  const checks = work.pairs.length - fit;
  const markers = useMemo(() => work.pairs.flatMap((pair, index) => {
    const point = pair.source.point, aligned = work.aligned && report ? report : null;
    const origin = meshSource?.mesh.origin ?? [0, 0, 0];
    const source = pointSource ? pointPreviewPosition(pointSource, aligned, point, true)
      : aligned ? scanPreviewPoint(aligned, point, true) : { x: point[0] - origin[0], y: point[1] - origin[1], z: point[2] - origin[2] };
    const marker = { id: `P${index + 1}`, point: source, check: pair.partition === 'check' };
    const target = aligned ? (pointSource ? pointPreviewPosition(pointSource, aligned, pair.correspondence.target, false) : scanPreviewPoint(aligned, pair.correspondence.target, false)) : null;
    return target ? [marker, { id: `IFC ${index + 1}`, point: target, check: true }] : [marker];
  }), [work.pairs, meshSource, pointSource, work.aligned, report]);
  const previewDisabled = work.busy || work.stale || transfer.busy || transfer.ready;
  const previewInstruction = work.aligned ? t('appearance.scan.alignedInstruction') : undefined;
  return <section className="space-y-3 pt-4" aria-label={t('appearance.scan.sectionAriaLabel')} aria-busy={work.busy}>
    <fieldset className="space-y-3" disabled={transfer.busy || transfer.ready}><div><h2 className="text-sm font-semibold">{t('appearance.scan.heading')}</h2><p className="mt-1 text-xs text-muted-foreground">{t('appearance.scan.description')}</p></div>
    <label className="block text-xs">{t('appearance.scan.sourceLabel')}<select className="mt-1 w-full rounded border bg-background p-2" value={work.sourceId} disabled={work.busy} onChange={event => work.setSourceId(event.target.value)}><option value="">{t('appearance.scan.chooseSource')}</option>{work.sources.map(source => <option key={source.id} value={source.id}>{source.kind === 'surface' ? t('appearance.scan.surfaceSource', { model: source.modelName, number: formatLocaleNumber(locale, source.surfaceNumber ?? 0) }) : t('appearance.scan.pointCloudSource', { model: source.modelName, retained: formatLocaleNumber(locale, source.retainedCount ?? 0), seen: formatLocaleNumber(locale, source.seenCount ?? 0) })}</option>)}</select></label>
    <label className="block text-xs">{t('appearance.scan.targetModelLabel')}<select className="mt-1 w-full rounded border bg-background p-2" value={work.targetId} disabled={work.busy} onChange={event => work.setTargetId(event.target.value)}><option value="">{t('appearance.scan.chooseTargetModel')}</option>{work.targets.map(target => <option key={target.id} value={target.id}>{target.name}</option>)}</select></label>
    {mesh && meshSource && <AppearanceMeshPreview mesh={mesh} assetId={meshSource.assetId} triangles={triangles} disabled={previewDisabled} regionControls={false} onRegion={ignoreRegion} onReady={work.setPreviewReady} onError={work.previewError} onLandmark={hit => work.pickSource(sourceLandmark(meshSource.mesh, hit, meshSource.meshOrdinal))} markers={markers} canvasLabel={t('appearance.scan.canvasLabel')} instruction={previewInstruction ?? t('appearance.scan.defaultInstruction')} />}
    {points && pointSource && <AppearancePointPreview source={pointSource} positions={points} disabled={previewDisabled} onReady={work.setPreviewReady} onError={work.previewError} onLandmark={index => work.pickSource(pointLandmark(pointSource, index))} markers={markers} canvasLabel={t('appearance.scan.canvasLabel')} instruction={previewInstruction} />}
    <div role="group" aria-label={t('appearance.scan.purposeAriaLabel')} className="grid grid-cols-2 gap-2">
      <Button size="sm" variant={work.partition === 'fit' ? 'secondary' : 'outline'} aria-pressed={work.partition === 'fit'} disabled={work.busy || work.aligned} onClick={() => work.setPartition('fit')}>{t('appearance.scan.fitCount', { count: fit })}</Button>
      <Button size="sm" variant={work.partition === 'check' ? 'secondary' : 'outline'} aria-pressed={work.partition === 'check'} disabled={work.busy || work.aligned} onClick={() => work.setPartition('check')}>{t('appearance.scan.checkCount', { count: checks })}</Button>
    </div>
    <p className="text-xs text-muted-foreground">{t('appearance.scan.fitCheckNote')}</p>
    {work.pairs.length > 0 && <ol className="max-h-48 space-y-1 overflow-y-auto" aria-label={t('appearance.scan.pairsAriaLabel')}>{work.pairs.map((pair, index) => {
      const residual = (pair.partition === 'fit' ? report?.fit : report?.heldOut)?.points.find(point => point.id === pair.correspondence.id);
      const landmark = `P${index + 1}`;
      return <li key={pair.correspondence.id} className="flex items-center gap-2 text-xs"><span>{landmark}</span><select aria-label={t('appearance.scan.purposeOfLandmark', { landmark })} value={pair.partition} disabled={work.busy} onChange={event => work.changePartition(pair.correspondence.id, event.target.value === 'fit' ? 'fit' : 'check')} className="rounded border bg-background p-1"><option value="fit">{t('appearance.scan.fitOption')}</option><option value="check">{t('appearance.scan.checkOption')}</option></select><span className="flex-1">{residual ? metres(residual.distanceMetres, locale, t) : t('appearance.scan.notMeasured')}</span><Button variant="ghost" size="sm" disabled={work.busy} aria-label={t('appearance.scan.removeLandmarkAriaLabel', { landmark })} onClick={() => work.remove(pair.correspondence.id)}>{t('appearance.scan.remove')}</Button></li>;
    })}</ol>}
    {report && <div className="space-y-1 rounded border p-2 text-xs" aria-label={t('appearance.scan.resultsAriaLabel')}><p>{t('appearance.scan.fitRms', { rms: metres(report.fit.rmsMetres, locale, t), max: metres(report.fit.maxMetres, locale, t) })}</p><p>{t('appearance.scan.checkRms', { rms: metres(report.heldOut.rmsMetres, locale, t), max: metres(report.heldOut.maxMetres, locale, t) })}</p><p>{t('appearance.scan.spreadRatio', { ratio: formatLocaleNumber(locale, report.sourceSpread.nonCollinearityRatio, { minimumSignificantDigits: 3, maximumSignificantDigits: 3 }) })}</p>{report.diagnostics.map(diagnostic => <p key={diagnostic}>{diagnostic}</p>)}<p>{t('appearance.scan.inspectNote')}</p></div>}
    <p role={work.error ? 'alert' : 'status'} aria-live="polite" className={`text-xs ${work.error ? 'text-destructive' : 'text-muted-foreground'}`}>{work.status.kind === 'translated' ? t(work.status.key, work.status.params) : work.status.text}</p>
    <div className="flex flex-wrap gap-2">
      {(work.busy || work.pending) && <Button size="sm" variant="outline" onClick={work.cancel}>{t('appearance.scan.cancel')}</Button>}
      {work.canRevalidateAppearance && <Button size="sm" variant="outline" disabled={work.busy} onClick={() => void work.revalidateAppearance()}>{t('appearance.scan.revalidateLandmarks')}</Button>}
      {(work.stale || (work.error && !work.session)) && <Button size="sm" variant="outline" onClick={work.restart}>{t('appearance.scan.restart')}</Button>}
      <Button size="sm" disabled={!work.session || !work.previewReady || work.busy || work.stale || fit < 3} onClick={() => void work.calculate()}>{t('appearance.scan.calculateAlignment')}</Button>
      {report && <Button size="sm" variant="outline" disabled={work.busy || work.stale || !work.previewReady} aria-pressed={work.aligned} onClick={() => work.setAligned(!work.aligned)}>{work.aligned ? t('appearance.scan.returnToLandmarks') : t('appearance.scan.previewAlignment')}</Button>}
    </div>
    </fieldset>
    {work.busy && transfer.ready && <Button size="sm" variant="outline" onClick={work.cancel}>{t('appearance.scan.cancelAppearanceOperation')}</Button>}
    <ScanTransferFields transfer={transfer} disabled={work.busy || work.stale || !work.previewReady || !work.result || fit < 4 || checks < 4} />
  </section>;
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { useScanTransfer } from './useScanTransfer';
import { useTranslation, type TranslationKey } from '@/i18n';
export function ScanTransferFields({ transfer, disabled }: { transfer: ReturnType<typeof useScanTransfer>; disabled: boolean }) {
  const { t } = useTranslation();
  const { settings, coverage } = transfer;
  const [search, setSearch] = useState('');
  const targets = transfer.targets.filter(target => target.name.toLowerCase().includes(search.toLowerCase()));
  const update = (key: Exclude<keyof typeof settings, 'reviewed'>, value: string) => transfer.setSettings(previous => ({ ...previous, [key]: Number(value), reviewed: key === 'toleranceMetres' ? false : previous.reviewed }));
  const total = coverage ? coverage.coverage.observedAreaEstimateM2 + coverage.coverage.unknownAreaEstimateM2 : 0;
  const orientation = coverage?.source.kind === 'points' ? coverage.source.orientation : null;
  const orientationLabel = orientation === 'source-normals' ? t('appearance.scanTransfer.orientationSourceNormals') : orientation === 'viewpoints' ? t('appearance.scanTransfer.orientationViewpoints') : t('appearance.scanTransfer.orientationTargetReferenced');
  const SAMPLING_FIELDS: ReadonlyArray<readonly [Exclude<keyof typeof settings, 'reviewed'>, TranslationKey, number]> = [
    ['texelsPerMetre', 'appearance.scanTransfer.pixelsPerMetre', 1], ['maxDistanceMetres', 'appearance.scanTransfer.maxScanDistance', 0.001],
    ['minNormalDot', 'appearance.scanTransfer.minNormalAgreement', 0.05], ['ambiguityDistanceMetres', 'appearance.scanTransfer.ambiguityDistance', 0.001],
    ['maxBehindMetres', 'appearance.scanTransfer.maxBehindDepth', 0.001],
  ];
  const POINT_SAMPLING_FIELDS: ReadonlyArray<readonly [Exclude<keyof typeof settings, 'reviewed'>, TranslationKey, number]> = [
    ['neighborhoodRadiusMetres', 'appearance.scanTransfer.pointSupportRadius', 0.005], ['surfaceBandMetres', 'appearance.scanTransfer.pointSurfaceBand', 0.001],
    ['minNeighbors', 'appearance.scanTransfer.minSupportingPoints', 1], ['maxNeighbors', 'appearance.scanTransfer.maxSupportingPoints', 1],
  ];
  return <section className="space-y-3 border-t pt-3" aria-label={t('appearance.scanTransfer.sectionAriaLabel')}>
    <h3 className="text-sm font-semibold">{t('appearance.scanTransfer.heading')}</h3>
    <p className="text-xs text-muted-foreground">{t('appearance.scanTransfer.description')}</p>
    <fieldset disabled={disabled || transfer.busy || transfer.ready} className="space-y-3">
      <Button size="sm" variant="outline" disabled={!transfer.selectedCount} onClick={transfer.chooseSelection}>{t('appearance.scanTransfer.useSelected', { count: transfer.selectedCount })}</Button>
      <details><summary className="cursor-pointer text-xs">{t('appearance.scanTransfer.chooseByName')}</summary><input aria-label={t('appearance.scanTransfer.findTargetAriaLabel')} value={search} onChange={event => setSearch(event.target.value)} placeholder={t('appearance.scanTransfer.findPlaceholder')} className="my-2 w-full rounded border bg-background p-2 text-xs" /><div className="max-h-40 space-y-1 overflow-y-auto">{targets.slice(0, 100).map(target => <label key={target.id} className="flex gap-2 text-xs"><input type="checkbox" aria-label={t('appearance.scanTransfer.transferToTarget', { name: target.name, id: target.id })} checked={transfer.productIds.includes(target.id)} onChange={event => transfer.setProductIds(previous => event.target.checked ? [...previous, target.id] : previous.filter(id => id !== target.id))} />{target.name} #{target.id}</label>)}</div>{targets.length > 100 && <p className="text-xs">{t('appearance.scanTransfer.showingFirst100')}</p>}</details>
      <p className="text-xs">{transfer.productIds.length ? t('appearance.scanTransfer.targetsChosen', { count: transfer.productIds.length, ids: transfer.productIds.map(id => `#${id}`).join(', ') }) : t('appearance.scanTransfer.noTargets')}</p>
      <label className="block text-xs">{t('appearance.scanTransfer.toleranceLabel')}<input aria-label={t('appearance.scanTransfer.toleranceAriaLabel')} className="mt-1 w-full rounded border bg-background p-2" type="number" min="0.000001" step="0.001" value={settings.toleranceMetres} onChange={event => update('toleranceMetres', event.target.value)} /></label>
      <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={settings.reviewed} onChange={event => transfer.setSettings(previous => ({ ...previous, reviewed: event.target.checked }))} />{t('appearance.scanTransfer.reviewedLabel')}</label>
      <details><summary className="cursor-pointer text-xs">{t('appearance.scanTransfer.samplingControls')}</summary><div className="mt-2 space-y-2">{SAMPLING_FIELDS.map(([key, labelKey, step]) => <label key={key} className="block text-xs">{t(labelKey)}<input aria-label={t(labelKey)} type="number" step={step} className="ml-2 w-24 rounded border bg-background p-1" value={settings[key]} onChange={event => update(key, event.target.value)} /></label>)}
      {transfer.pointSource && <>{POINT_SAMPLING_FIELDS.map(([key, labelKey, step]) => <label key={key} className="block text-xs">{t(labelKey)}<input aria-label={t(labelKey)} type="number" step={step} className="ml-2 w-24 rounded border bg-background p-1" value={settings[key]} onChange={event => update(key, event.target.value)} /></label>)}
      <p className="text-xs text-muted-foreground">{t('appearance.scanTransfer.pointColourNote')}</p></>}</div></details>
    </fieldset>
    {coverage && <div className="space-y-1 rounded border p-2 text-xs" aria-label={t('appearance.scanTransfer.coverageAriaLabel')}><p>{t('appearance.scanTransfer.estimatedObservedArea', { percent: total ? (100 * coverage.coverage.observedAreaEstimateM2 / total).toFixed(1) : '0' })}</p><p>{t('appearance.scanTransfer.interiorTexels', { observed: coverage.coverage.observedRasterInteriorTexels.toLocaleString(), total: coverage.coverage.rasterInteriorTexels.toLocaleString() })}</p><p>{t('appearance.scanTransfer.observedSamples', { observed: coverage.coverage.observedSamples.toLocaleString(), total: coverage.coverage.samples.toLocaleString() })}</p><p>{t('appearance.scanTransfer.unknownSummary', {
      tooFar: coverage.coverage.unknownDistanceSamples.toLocaleString(),
      incompatibleNormals: coverage.coverage.unknownNormalSamples.toLocaleString(),
      ambiguous: coverage.coverage.unknownAmbiguousSamples.toLocaleString(),
      behind: coverage.coverage.unknownBehindSamples.toLocaleString(),
      sparse: coverage.source.kind === 'points' ? t('appearance.scanTransfer.tooSparseSuffix', { count: coverage.coverage.unknownSparseSamples.toLocaleString() }) : '',
    })}</p>{coverage.source.kind === 'points' && <p>{t('appearance.scanTransfer.pointCloudSourceNote', { count: (coverage.source.pointCount ?? 0).toLocaleString(), orientation: orientationLabel })}</p>}<details><summary className="cursor-pointer">{t('appearance.scanTransfer.coveragePerSurface')}</summary>{coverage.items.map(item => <p key={`${item.productId}:${item.geometryItemId}`}>{t('appearance.scanTransfer.surfaceCoverageRow', { productId: item.productId, geometryItemId: item.geometryItemId, observed: item.observedSamples.toLocaleString(), total: item.samples.toLocaleString() })}</p>)}</details><p>{t('appearance.scanTransfer.areaCaveat')}</p>{coverage.exclusions.map(item => <p key={`${item.productId}:${item.reason}`}>{t('appearance.scanTransfer.exclusionRow', { productId: item.productId, reason: item.reason })}</p>)}</div>}
    <p role={transfer.error ? 'alert' : 'status'} className={`text-xs ${transfer.error ? 'text-destructive' : 'text-muted-foreground'}`}>{transfer.status.kind === 'translated' ? t(transfer.status.key, transfer.status.params) : transfer.status.text}</p>
    <div className="flex flex-wrap gap-2">
      {!transfer.ready && <Button size="sm" disabled={disabled || transfer.busy || !settings.reviewed || !transfer.productIds.length} onClick={() => void transfer.preview()}>{t('appearance.scanTransfer.previewTransfer')}</Button>}
      {transfer.ready && <><Button size="sm" variant="outline" disabled={disabled} onClick={transfer.compare}>{transfer.original ? t('appearance.scanTransfer.showTransfer') : t('appearance.scanTransfer.showOriginal')}</Button><Button size="sm" disabled={disabled} onClick={() => void transfer.apply()}>{t('appearance.scanTransfer.applyAppearance')}</Button></>}
      {(transfer.busy || transfer.ready) && <Button size="sm" variant="outline" disabled={disabled && !transfer.busy} onClick={transfer.discard}>{transfer.busy ? t('appearance.scanTransfer.cancelTransfer') : t('appearance.scanTransfer.discardTransfer')}</Button>}
    </div>
  </section>;
}

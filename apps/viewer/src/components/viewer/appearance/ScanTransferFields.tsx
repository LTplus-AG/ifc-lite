/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { useScanTransfer } from './useScanTransfer';
export function ScanTransferFields({ transfer, disabled }: { transfer: ReturnType<typeof useScanTransfer>; disabled: boolean }) {
  const { settings, coverage } = transfer;
  const [search, setSearch] = useState('');
  const targets = transfer.targets.filter(target => target.name.toLowerCase().includes(search.toLowerCase()));
  const update = (key: 'toleranceMetres' | 'texelsPerMetre' | 'maxDistanceMetres' | 'minNormalDot' | 'ambiguityDistanceMetres', value: string) => transfer.setSettings(previous => ({ ...previous, [key]: Number(value), reviewed: key === 'toleranceMetres' ? false : previous.reviewed }));
  const total = coverage ? coverage.coverage.observedAreaEstimateM2 + coverage.coverage.unknownAreaEstimateM2 : 0;
  return <section className="space-y-3 border-t pt-3" aria-label="Scan appearance transfer">
    <h3 className="text-sm font-semibold">Transfer scan appearance</h3>
    <p className="text-xs text-muted-foreground">Select the destination objects in the IFC view. Transfer uses their complete surfaces; it never reduces the chosen scope automatically.</p>
    <fieldset disabled={disabled || transfer.busy || transfer.ready} className="space-y-3">
      <Button size="sm" variant="outline" disabled={!transfer.selectedCount} onClick={transfer.chooseSelection}>Use selected IFC objects · {transfer.selectedCount}</Button>
      <details><summary className="cursor-pointer text-xs">Choose objects by name</summary><input aria-label="Find transfer target" value={search} onChange={event => setSearch(event.target.value)} placeholder="Find an IFC object" className="my-2 w-full rounded border bg-background p-2 text-xs" /><div className="max-h-40 space-y-1 overflow-y-auto">{targets.slice(0, 100).map(target => <label key={target.id} className="flex gap-2 text-xs"><input type="checkbox" aria-label={`Transfer to ${target.name} #${target.id}`} checked={transfer.productIds.includes(target.id)} onChange={event => transfer.setProductIds(previous => event.target.checked ? [...previous, target.id] : previous.filter(id => id !== target.id))} />{target.name} · #{target.id}</label>)}</div>{targets.length > 100 && <p className="text-xs">Showing the first 100 matches. Refine the search to choose another object.</p>}</details>
      <p className="text-xs">{transfer.productIds.length ? `${transfer.productIds.length} target object(s): ${transfer.productIds.map(id => `#${id}`).join(', ')}` : 'No target objects chosen.'}</p>
      <label className="block text-xs">Project tolerance (m)<input aria-label="Transfer project tolerance" className="mt-1 w-full rounded border bg-background p-2" type="number" min="0.000001" step="0.001" value={settings.toleranceMetres} onChange={event => update('toleranceMetres', event.target.value)} /></label>
      <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={settings.reviewed} onChange={event => transfer.setSettings(previous => ({ ...previous, reviewed: event.target.checked }))} />I reviewed the fit/check errors and landmark spread against this tolerance.</label>
      <details><summary className="cursor-pointer text-xs">Sampling controls</summary><div className="mt-2 space-y-2">{([
        ['texelsPerMetre', 'Pixels per metre', 1], ['maxDistanceMetres', 'Maximum scan distance (m)', 0.001],
        ['minNormalDot', 'Minimum normal agreement', 0.05], ['ambiguityDistanceMetres', 'Ambiguity distance (m)', 0.001],
      ] as const).map(([key, label, step]) => <label key={key} className="block text-xs">{label}<input aria-label={label} type="number" step={step} className="ml-2 w-24 rounded border bg-background p-1" value={settings[key]} onChange={event => update(key, event.target.value)} /></label>)}</div></details>
    </fieldset>
    {coverage && <div className="space-y-1 rounded border p-2 text-xs" aria-label="Scan transfer coverage"><p>Estimated observed area: {total ? (100 * coverage.coverage.observedAreaEstimateM2 / total).toFixed(1) : '0'}%</p><p>{coverage.coverage.observedRasterInteriorTexels.toLocaleString()} transferred interior texels of {coverage.coverage.rasterInteriorTexels.toLocaleString()}.</p><p>{coverage.coverage.observedSamples.toLocaleString()} observed samples of {coverage.coverage.samples.toLocaleString()}.</p><p>Unknown: {coverage.coverage.unknownDistanceSamples.toLocaleString()} too far · {coverage.coverage.unknownNormalSamples.toLocaleString()} incompatible normals · {coverage.coverage.unknownAmbiguousSamples.toLocaleString()} ambiguous.</p><details><summary className="cursor-pointer">Coverage per IFC surface</summary>{coverage.items.map(item => <p key={`${item.productId}:${item.geometryItemId}`}>#{item.productId} / surface #{item.geometryItemId}: {item.observedSamples.toLocaleString()} of {item.samples.toLocaleString()} samples observed.</p>)}</details><p>Area includes diagnostic centroid samples and is not an exact surface integral. Transferred texels count image interiors, excluding padding. Unknown samples keep the previous IFC appearance.</p>{coverage.exclusions.map(item => <p key={`${item.productId}:${item.reason}`}>#{item.productId}: {item.reason}</p>)}</div>}
    <p role={transfer.error ? 'alert' : 'status'} className={`text-xs ${transfer.error ? 'text-destructive' : 'text-muted-foreground'}`}>{transfer.status}</p>
    <div className="flex flex-wrap gap-2">
      {!transfer.ready && <Button size="sm" disabled={disabled || transfer.busy || !settings.reviewed || !transfer.productIds.length} onClick={() => void transfer.preview()}>Preview transfer</Button>}
      {transfer.ready && <><Button size="sm" variant="outline" disabled={disabled} onClick={transfer.compare}>{transfer.original ? 'Show transfer' : 'Show original'}</Button><Button size="sm" disabled={disabled} onClick={() => void transfer.apply()}>Apply scan appearance</Button></>}
      {(transfer.busy || transfer.ready) && <Button size="sm" variant="outline" disabled={disabled && !transfer.busy} onClick={transfer.discard}>{transfer.busy ? 'Cancel transfer' : 'Discard transfer'}</Button>}
    </div>
  </section>;
}

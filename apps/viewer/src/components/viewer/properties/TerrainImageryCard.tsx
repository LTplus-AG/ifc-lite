/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The terrain-imagery card of a LandXML model's properties (#5942, mapping
 * spec §15.4): what is draped, from which CRS, at what ground sample distance,
 * and how much of the terrain it covers — and the tile-source form, whose
 * drapes are viewer-only (§15.2 item 7).
 */

import { useState } from 'react';
import { Image as ImageIcon } from 'lucide-react';
import type { FederatedModel } from '@/store';
import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { coveredFraction } from '@/lib/terrain-imagery/drape-state';
import type { TileSourceSpec } from '@/lib/terrain-imagery/tile-source';
import { terrainCrsOf } from '@/hooks/ingest/terrainImageryPlan';

const FIELD = 'w-full rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-2 py-1 text-xs font-mono';

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-3 px-3 py-2">
      <span className="text-xs text-zinc-500 shrink-0">{label}</span>
      <span className="text-xs font-mono text-zinc-900 dark:text-zinc-100 ml-auto text-right break-all">{value}</span>
    </div>
  );
}

function TileSourceForm({ model }: { model: FederatedModel }) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<'xyz' | 'wms'>('xyz');
  const [url, setUrl] = useState('');
  const [zoom, setZoom] = useState('17');
  const [layers, setLayers] = useState('');
  const [resolution, setResolution] = useState('0.5');
  const [busy, setBusy] = useState(false);
  const idPrefix = `terrain-tiles-${model.id}`;

  const drape = async () => {
    const spec: TileSourceSpec = kind === 'xyz'
      ? { kind, urlTemplate: url.trim(), zoom: Number(zoom) }
      : { kind, url: url.trim(), layers: layers.trim(), resolution: Number(resolution) };
    setBusy(true);
    try {
      const [{ drapeTileSource }, { reportDrapeOutcomes }] = await Promise.all([
        import('@/hooks/ingest/terrainImageryTiles'), import('@/hooks/ingest/terrainImageryDrape'),
      ]);
      const result = await drapeTileSource(model, spec);
      if (result.ok) reportDrapeOutcomes(result.value);
      else toast.error(t('terrainImagery.tiles.refused', { reason: result.reason }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="px-3 py-2 space-y-2">
      <p className="text-xs text-zinc-500">{t('terrainImagery.tiles.viewerOnly')}</p>
      <div className="flex gap-2">
        <label htmlFor={`${idPrefix}-kind`} className="text-xs text-zinc-500 self-center">{t('terrainImagery.tiles.kind')}</label>
        <select id={`${idPrefix}-kind`} className={FIELD} value={kind} onChange={(event) => setKind(event.target.value as 'xyz' | 'wms')}>
          <option value="xyz">{t('terrainImagery.tiles.kindXyz')}</option>
          <option value="wms">{t('terrainImagery.tiles.kindWms')}</option>
        </select>
      </div>
      <label htmlFor={`${idPrefix}-url`} className="block text-xs text-zinc-500">
        {kind === 'xyz' ? t('terrainImagery.tiles.template') : t('terrainImagery.tiles.wmsUrl')}
      </label>
      <input id={`${idPrefix}-url`} className={FIELD} value={url} onChange={(event) => setUrl(event.target.value)}
        placeholder={kind === 'xyz' ? t('terrainImagery.tiles.templatePlaceholder') : t('terrainImagery.tiles.wmsPlaceholder')} />
      {kind === 'xyz' ? (
        <>
          <label htmlFor={`${idPrefix}-zoom`} className="block text-xs text-zinc-500">{t('terrainImagery.tiles.zoom')}</label>
          <input id={`${idPrefix}-zoom`} className={FIELD} type="number" min={0} max={24} value={zoom} onChange={(event) => setZoom(event.target.value)} />
        </>
      ) : (
        <>
          <label htmlFor={`${idPrefix}-layers`} className="block text-xs text-zinc-500">{t('terrainImagery.tiles.layers')}</label>
          <input id={`${idPrefix}-layers`} className={FIELD} value={layers} onChange={(event) => setLayers(event.target.value)} />
          <label htmlFor={`${idPrefix}-resolution`} className="block text-xs text-zinc-500">{t('terrainImagery.tiles.resolution')}</label>
          <input id={`${idPrefix}-resolution`} className={FIELD} type="number" min={0} step="any" value={resolution} onChange={(event) => setResolution(event.target.value)} />
        </>
      )}
      <Button size="sm" variant="outline" disabled={busy || url.trim() === ''} onClick={() => { void drape(); }}>
        {busy ? t('terrainImagery.tiles.fetching') : t('terrainImagery.tiles.drape')}
      </Button>
    </div>
  );
}

export function TerrainImageryCard({ model }: { model: FederatedModel }) {
  const { t, locale } = useTranslation();
  const drape = model.terrainImagery;
  const crs = terrainCrsOf(model.landXmlDocument ?? {});
  const unit = model.landXmlDocument?.units?.linearUnit ?? '';
  return (
    <div className="border-b border-zinc-200 dark:border-zinc-800">
      <div className="p-3 bg-zinc-50 dark:bg-zinc-900/50 flex items-center gap-2">
        <ImageIcon className="h-3.5 w-3.5 text-zinc-400" />
        <h4 className="font-bold text-xs uppercase tracking-wide text-zinc-700 dark:text-zinc-300">{t('terrainImagery.heading')}</h4>
      </div>
      {!crs.ok && <p className="px-3 py-2 text-xs text-amber-700 dark:text-amber-400">{crs.reason}</p>}
      {drape ? (
        <div className="divide-y divide-zinc-100 dark:divide-zinc-900">
          <Row label={t('terrainImagery.source')}
            value={drape.source === 'tiles' ? t('terrainImagery.sourceTiles', { name: drape.sourceName }) : drape.sourceName} />
          <Row label={t('terrainImagery.crs')} value={drape.reprojected
            ? t('terrainImagery.crsReprojected', { image: drape.imageCrs, terrain: drape.projection.crs })
            : drape.imageCrs} />
          <Row label={t('terrainImagery.gsd')}
            value={t('terrainImagery.gsdValue', { gsd: formatLocaleNumber(locale, drape.displayedGsd, { maximumFractionDigits: 3 }), unit })} />
          <Row label={t('terrainImagery.covered')} value={t('terrainImagery.coveredValue', {
            percent: formatLocaleNumber(locale, coveredFraction(drape) * 100, { maximumFractionDigits: 1 }),
            covered: formatLocaleNumber(locale, drape.coveredVertices),
            total: formatLocaleNumber(locale, drape.totalVertices),
          })} />
        </div>
      ) : (
        <p className="px-3 py-2 text-xs text-zinc-500">{t('terrainImagery.none')}</p>
      )}
      {crs.ok && <TileSourceForm model={model} />}
    </div>
  );
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The terrain-imagery card of a LandXML model's properties (#5942, mapping
 * spec §15.4): what is draped, from which CRS, at what ground sample distance,
 * and how much of the terrain it covers.
 */

import { Image as ImageIcon } from 'lucide-react';
import type { FederatedModel } from '@/store';
import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import { coveredFraction } from '@/lib/terrain-imagery/drape-state';
import { terrainCrsOf } from '@/hooks/ingest/terrainImageryPlan';

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-3 px-3 py-2">
      <span className="text-xs text-zinc-500 shrink-0">{label}</span>
      <span className="text-xs font-mono text-zinc-900 dark:text-zinc-100 ml-auto text-right break-all">{value}</span>
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
    </div>
  );
}

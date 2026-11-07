/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { Row } from '@ifc-lite/flow';
import { useTranslation } from '@/i18n/useTranslation';

/** The existing dashboard renderer supports bars/pies/treemaps; this bounded
 * history needs only a line, with actual timestamp spacing. */
export function InfluxHistory({ rows, name }: { rows: readonly Row[]; name: string }) {
  const { t } = useTranslation();
  const samples = rows.map(row => ({ time: Date.parse(String(row._time)), value: Number(row._value) })).sort((a, b) => a.time - b.time);
  if (!samples.length) return null;
  const times = samples.map(sample => sample.time), values = samples.map(sample => sample.value);
  const start = Math.min(...times), duration = Math.max(...times) - start || 1;
  const scale = Math.max(1, ...values.map(Math.abs));
  const low = Math.min(...values) / scale, high = Math.max(...values) / scale;
  const range = high - low || 1;
  const points = samples.map(sample => `${10 + (sample.time - start) / duration * 280},${high === low ? 60 : 110 - (sample.value / scale - low) / range * 100}`).join(' ');
  return <svg aria-label={t('influx.history', { name, samples: samples.length })} viewBox="0 0 300 120" className="w-full h-32 text-primary">
    <title>{t('influx.history', { name, samples: samples.length })}</title>
    <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" />
    {samples.length === 1 && <circle cx="10" cy="60" r="3" fill="currentColor" />}
  </svg>;
}

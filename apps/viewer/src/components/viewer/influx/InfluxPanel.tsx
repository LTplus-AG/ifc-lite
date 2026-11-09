/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchInfluxReadings, InfluxRequestError, matchInfluxSeries } from '@ifc-lite/flow-nodes/influx';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useTranslation } from '@/i18n/useTranslation';
import type { TranslationKey } from '@/i18n';
import { useViewerStore } from '@/store';
import { resolveEntityRef } from '@/store/resolveEntityRef';
import { configFields, readInfluxConfig, saveInfluxConfig, influxSelection, type InfluxConfig } from '@/lib/influx/config';
import { influxTargets } from '@/lib/influx/targets';
import { InfluxHistory } from './InfluxHistory';

const responseColumns = new Set(['result', 'table', '_start', '_stop', '_time', '_value', '_measurement', '_field']);

type Readings = Awaited<ReturnType<typeof fetchInfluxReadings>>;
const errorKeys = { config: 'influx.error.config', network: 'influx.error.network', http: 'influx.error.http', data: 'influx.error.data' } as const;

export function InfluxPanel() {
  const { t, locale } = useTranslation();
  const [config, setConfig] = useState(readInfluxConfig);
  // Deliberately local state: never enters the persisted viewer store or Flow.
  const [token, setToken] = useState('');
  const [data, setData] = useState<Readings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TranslationKey | null>(null);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const models = useViewerStore(s => s.models);
  const ifcDataStore = useViewerStore(s => s.ifcDataStore);
  const mutationViews = useViewerStore(s => s.mutationViews);
  const selectedId = useViewerStore(s => s.selectedEntityId);
  const targets = useMemo(() => influxTargets(useViewerStore.getState()), [models, ifcDataStore, mutationViews]);
  const joined = useMemo(() => data ? matchInfluxSeries(data.latest, targets) : null, [data, targets]);
  const selected = selectedId === null ? null : resolveEntityRef(selectedId);
  const match = joined?.matched.find(item => item.target.modelId === selected?.modelId && item.target.expressId === selected?.expressId);
  const history = match && data ? data.history.rows.filter(row => row[config.guidTag] === match.target.GlobalId) : [];

  useEffect(() => () => { generation.current++; request.current?.abort(); }, []);
  function invalidate() {
    generation.current++;
    request.current?.abort();
    setData(null);
    setBusy(false);
    setError(null);
  }
  function change(key: keyof InfluxConfig, value: string) {
    invalidate();
    setConfig(previous => ({ ...previous, [key]: value }));
  }
  async function load() {
    invalidate();
    const current = generation.current;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    try {
      try { saveInfluxConfig(config, token); }
      catch { setError('influx.error.storage'); return; }
      const readings = await fetchInfluxReadings(influxSelection(config), token, fetch, controller.signal);
      if (current === generation.current) setData(readings);
    } catch (cause) {
      if (current === generation.current) setError(errorKeys[cause instanceof InfluxRequestError ? cause.kind : 'data']);
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  return <section aria-label={t('influx.title')} className="h-full overflow-auto p-4 space-y-4 text-sm">
    <div className="flex items-center justify-between gap-2"><h2 className="font-semibold">{t('influx.title')}</h2><span className="rounded bg-muted px-2 py-1 text-xs">{t('influx.experimental')}</span></div>
    <p className="text-muted-foreground">{t('influx.help')}</p>
    <details open={!data} className="space-y-3">
      <summary className="cursor-pointer">{t('influx.experimental')}</summary>
      <div className="grid grid-cols-1 gap-2">
        {configFields.map(key => <label key={key} className="grid gap-1">{t(`influx.${key}`)}
          <Input type={key === 'url' ? 'url' : 'text'} value={config[key]} onChange={event => change(key, event.target.value)} autoComplete="off" />
        </label>)}
        <label className="grid gap-1">{t('influx.token')}<Input type="password" value={token} onChange={event => { invalidate(); setToken(event.target.value); }} autoComplete="off" /></label>
      </div>
    </details>
    <p className="text-xs text-muted-foreground">{t('influx.bounds')}</p>
    <Button onClick={() => void load()} disabled={busy}>{t(busy ? 'influx.loading' : 'influx.load')}</Button>
    {error && <p role="alert" className="text-destructive">{t(error)}</p>}
    {data && <>
      <output className="block">{t('influx.loaded', { samples: data.history.rows.length })}</output>
      {match ? <div className="rounded border p-3 space-y-2">
        <h3 className="font-semibold break-words">{match.target.Name}</h3>
        <p className="text-lg font-semibold">{t('influx.latest', { value: Number(match.row._value).toLocaleString(locale), unit: config.unit })}</p>
        <p className="break-all text-xs text-muted-foreground">{match.target.GlobalId}</p>
        <InfluxHistory rows={history} name={match.target.Name} />
        <p className="text-xs text-muted-foreground">{t('influx.timestamp', { time: String(match.row._time) })}</p>
      </div> : <p>{t('influx.select')}</p>}
      {(['unmatched', 'ambiguous'] as const).map(kind => <div key={kind}>
        <h3 className="font-semibold">{t(`influx.${kind}`, { count: joined?.[kind].length ?? 0 })}</h3>
        <ul className="space-y-1 text-xs break-all">{joined?.[kind].length ? joined[kind].map((row, index) => <li key={index}>{JSON.stringify(Object.fromEntries(Object.entries(row).filter(([key]) => !responseColumns.has(key))))}</li>) : <li>{t('influx.none')}</li>}</ul>
      </div>)}
    </>}
  </section>;
}

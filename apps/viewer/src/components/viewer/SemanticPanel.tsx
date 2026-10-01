/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo, useState } from 'react';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { mutationPermission, mutationDenialKey } from '@/store/mutation-permission';
import { createSelectionAdapter } from '@/sdk/adapters/selection-adapter';
import { DEFAULT_MAPPING } from '@/lib/semantic/transport';
import { PILOT_QUERY, pilotDocument } from '@/lib/semantic/demo';
import { useSemanticPilot } from '@/lib/semantic/useSemanticPilot';
import { relatedResources, resolveResource, selectionTargets } from '@/lib/semantic/resolver';
import { liveEntities, projectFireRating, selectResources } from '@/lib/semantic/viewer';
import type { SemanticResource } from '@/lib/semantic/types';

const control = 'w-full rounded border border-border bg-background p-2 text-sm';
const button = 'rounded border border-border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50';

export function SemanticPanel() {
  const { t } = useTranslation();
  const pilot = useSemanticPilot();
  const [mode, setMode] = useState('local');
  const [payload, setPayload] = useState(() => JSON.stringify(pilot.document ?? pilotDocument(), null, 2));
  const [endpoint, setEndpoint] = useState('');
  const [host, setHost] = useState('');
  const [query, setQuery] = useState(PILOT_QUERY);
  const [mapping, setMapping] = useState(DEFAULT_MAPPING);
  const [scope, setScope] = useState('');
  const [revision, setRevision] = useState('');
  const [model, setModel] = useState('');
  const [onlySelected, setOnlySelected] = useState(false);
  const [active, setActive] = useState('');
  const [message, setMessage] = useState('');
  const models = useViewerStore(s => s.models);
  const mutationVersion = useViewerStore(s => s.mutationVersion);
  const selectedIds = useViewerStore(s => s.selectedEntityIds);
  const selectedId = useViewerStore(s => s.selectedEntityId);
  const editDenial = useViewerStore(s => { const permission = mutationPermission(s); return permission.allowed ? null : permission.reason; });
  const entities = useMemo(() => liveEntities(), [models, mutationVersion]);
  const resources = pilot.document?.resources ?? [];
  const resolution = (resource: SemanticResource) => resolveResource(resource, entities, pilot.revisions, scope || undefined);
  const selection = createSelectionAdapter(useViewerStore).get();
  // Subscribe to both numeric selection channels used by viewport and hierarchy.
  void selectedIds; void selectedId;
  const selectedResources = resources.filter(resource => {
    const result = resolution(resource);
    return result.status === 'resolved' && selection.some(ref => ref.modelId === result.ref.modelId && ref.expressId === result.ref.expressId);
  });
  const connected = relatedResources(resources, selectedResources.map(resource => resource.id));
  const visible = onlySelected ? connected : resources;
  const current = resources.find(resource => resource.id === active);
  const product = resources.find(resource => resource.id === current?.productId);
  function choose(resource: SemanticResource) {
    setActive(resource.id);
    selectResources(selectionTargets(resources, resource), pilot.revisions, scope || undefined);
  }
  return <section className="h-full overflow-auto p-3 space-y-3" aria-label={t('semantic.title')}>
    <p className="text-sm text-muted-foreground">{t('semantic.description')}</p>
    <div className="flex flex-wrap gap-2">
      <button className={button} disabled={pilot.busy} onClick={() => void pilot.demo(true)}>{t('semantic.demo')}</button>
      <button className={button} disabled={pilot.busy} onClick={() => void pilot.demo(false)}>{t('semantic.recordsOnly')}</button>
    </div>
    <label className="block text-sm">{t('semantic.mode')}<select className={control} value={mode} onChange={e => setMode(e.target.value)}>
      {(['local', 'json', 'sparql'] as const).map(value => <option key={value} value={value}>{t(`semantic.${value}`)}</option>)}
    </select></label>
    {mode === 'local' ? <label className="block text-sm">{t('semantic.payload')}<textarea className={control} rows={7} value={payload} onChange={e => setPayload(e.target.value)} /></label>
      : <><label className="block text-sm">{t('semantic.endpoint')}<input className={control} type="url" value={endpoint} onChange={e => setEndpoint(e.target.value)} /></label>
        <label className="block text-sm">{t('semantic.host')}<input className={control} value={host} onChange={e => setHost(e.target.value)} /></label></>}
    {mode === 'sparql' && <><label className="block text-sm">{t('semantic.query')}<textarea className={control} rows={7} value={query} onChange={e => setQuery(e.target.value)} /></label>
      <details><summary>{t('semantic.mapping')}</summary>{Object.entries(mapping).map(([key, value]) => <label key={key} className="block text-sm">{key}
        <input className={control} value={value} onChange={e => setMapping({ ...mapping, [key]: e.target.value })} /></label>)}</details></>}
    <div className="flex gap-2"><button className={button} disabled={pilot.busy} onClick={() => void pilot.load({ mode, payload, endpoint, host, query, mapping })}>{t('semantic.run')}</button>
      {pilot.busy && <button className={button} onClick={pilot.cancel}>{t('semantic.cancel')}</button>}</div>
    {pilot.error && <p role="alert" className="text-sm text-destructive">{pilot.error}</p>}
    {message && <output className="block text-sm">{message}</output>}
    <label className="block text-sm">{t('semantic.scope')}<select className={control} value={scope} onChange={e => setScope(e.target.value)}>
      <option value="">{t('semantic.allModels')}</option>{[...models].map(([id, loaded]) => <option key={id} value={id}>{loaded.name}</option>)}
    </select></label>
    <details><summary>{t('semantic.associate')}</summary>
      <label className="block text-sm">{t('semantic.revision')}<input className={control} type="url" value={revision} onChange={e => setRevision(e.target.value)} /></label>
      <label className="block text-sm">{t('semantic.model')}<select className={control} value={model} onChange={e => setModel(e.target.value)}>
        <option value="">{t('semantic.model')}</option>{[...models].map(([id, loaded]) => <option key={id} value={id}>{loaded.name}</option>)}
      </select></label>
      <button className={button} disabled={!revision || !models.has(model)} onClick={() => {
        try { new URL(revision); pilot.setRevisions(new Map(pilot.revisions).set(revision, model)); }
        catch (failure) { pilot.setError(String(failure)); }
      }}>{t('semantic.associate')}</button>
      <ul className="text-sm">{[...pilot.revisions].map(([uri, id]) => <li key={uri}>{uri} → {models.get(id)?.name ?? id}</li>)}</ul>
    </details>
    {pilot.document ? <>
      <p className="text-sm break-all">{t('semantic.source', { source: pilot.document.source })}</p>
      <p className="text-sm">{t(pilot.document.completeness === 'partial' ? 'semantic.partial' : 'semantic.complete')}</p>
      <div className="flex flex-wrap gap-2">
        <button className={button} onClick={() => selectResources(resources, pilot.revisions, scope || undefined)}>{t('semantic.selectAll')}</button>
        <button className={button} disabled={pilot.busy} onClick={() => void pilot.validate()}>{t('semantic.validate')}</button>
        <button className={button} disabled={pilot.busy} onClick={() => void pilot.exportBundle()}>{t('semantic.export')}</button>
      </div>
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={onlySelected} onChange={e => setOnlySelected(e.target.checked)} />{t('semantic.selected')}</label>
      <table className="w-full text-sm"><thead><tr><th className="text-left">{t('semantic.label')}</th><th>{t('semantic.type')}</th><th>{t('semantic.status')}</th></tr></thead>
        <tbody>{visible.map(resource => <tr key={resource.id} className={active === resource.id ? 'bg-muted' : ''}>
          <td><button className="p-2 text-left underline" aria-label={t('semantic.selectRecord', { label: resource.label })} onClick={() => choose(resource)}>{resource.label}</button></td>
          <td>{resource.type}</td><td>{t(`semantic.mappingStatus.${resolution(resource).status}`)}</td>
        </tr>)}</tbody></table>
      {current && <details open><summary>{t('semantic.related')}: {current.label}</summary><pre className="overflow-auto text-xs">{JSON.stringify(relatedResources(resources, [current.id]), null, 2)}</pre></details>}
      <p className="text-sm text-muted-foreground">{t('semantic.projection')}</p>
      {editDenial && <p className="text-sm">{t(mutationDenialKey(editDenial))}</p>}
      <button className={button} disabled={!!editDenial || !current || current.type !== 'Installation' || !product?.fireRating || resolution(current).status !== 'resolved'} onClick={() => {
        if (!current || !product || !pilot.document) return;
        try { projectFireRating(current, product, pilot.revisions, pilot.document.source, pilot.document.profile, scope || undefined);
          setMessage(t('semantic.projectionDone', { source: pilot.document.source, profile: pilot.document.profile })); }
        catch (failure) { pilot.setError(String(failure)); }
      }}>{t('semantic.project')}</button>
      <h3 className="font-medium">{t('semantic.validation')}</h3>
      {pilot.findings.length === 0 ? <p className="text-sm">{t('semantic.valid')}</p> : <ul className="space-y-2 text-sm">{pilot.findings.map((finding, index) =>
        <li key={index}><button className="text-left underline break-all" onClick={() => {
          const resource = resources.find(record => record.id === finding.resourceId); if (resource) choose(resource);
        }}>{finding.engine}: {finding.resourceId} — {finding.path}: {finding.message}</button></li>)}</ul>}
      <details><summary>{t('semantic.graph')}</summary><label className="block text-sm">{t('semantic.graph')}<textarea className={control} rows={10} value={pilot.graph} onChange={e => pilot.setGraph(e.target.value)} /></label>
        <button className={button} disabled={pilot.busy} onClick={() => void pilot.validate(true)}>{t('semantic.validateGraph')}</button></details>
      {pilot.results && <details><summary>{t('semantic.rawResults')}</summary><div className="overflow-auto"><table className="text-xs"><thead><tr>{pilot.results.columns.map(column => <th key={column}>{column}</th>)}</tr></thead>
        <tbody>{pilot.results.rows.map((row, index) => <tr key={index}>{pilot.results!.columns.map(column => <td className="p-2" key={column}><pre>{row[column] ? JSON.stringify(row[column], null, 2) : ''}</pre></td>)}</tr>)}</tbody></table></div></details>}
    </> : <p className="text-sm">{t('semantic.noRecords')}</p>}
  </section>;
}

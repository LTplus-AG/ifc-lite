/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { mutationPermission, mutationDenialKey } from '@/store/mutation-permission';
import { createSelectionAdapter } from '@/sdk/adapters/selection-adapter';
import { DEFAULT_MAPPING } from '@ifc-lite/semantic';
import { SemanticIdentityControls } from './SemanticIdentityControls';
import { SemanticProfileControls } from './SemanticProfileControls';
import { SemanticResults } from './SemanticResults';
import { SemanticValidationSummary } from './SemanticValidationSummary';
import { previewProjection, applyProjection, PROJECTION_MAPPINGS, type ProjectionPlan, type ConflictPolicy } from '@/lib/semantic/projection';
import type { ValidationExecutor } from '@/lib/semantic/useSemanticPilot';
import { PILOT_QUERY, pilotDocument } from '@/lib/semantic/demo';
import { useSemanticPilot } from '@/lib/semantic/useSemanticPilot';
import { relatedResources, resolveResource, selectionTargets } from '@/lib/semantic/resolver';
import { liveEntities, selectResources } from '@/lib/semantic/viewer';
import type { SemanticResource } from '@/lib/semantic/types';

const control = 'w-full rounded border border-border bg-background p-2 text-sm';
const button = 'rounded border border-border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50';

export function SemanticPanel({ validationExecutor }: { validationExecutor?: ValidationExecutor } = {}) {
  const { t } = useTranslation();
  const pilot = useSemanticPilot(validationExecutor);
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
  const [recordPage, setRecordPage] = useState(0);
  const [active, setActive] = useState('');
  const [message, setMessage] = useState('');
  const [bearer, setBearer] = useState('');
  const [relayProvider, setRelayProvider] = useState('');
  const [plan, setPlan] = useState<ProjectionPlan>();
  const [mappingId, setMappingId] = useState(PROJECTION_MAPPINGS[0].id);
  const [policy, setPolicy] = useState<ConflictPolicy>('error');
  const sourceInput = { mode, payload, endpoint, host, query, mapping, bearer: bearer || undefined, relayProvider: relayProvider || undefined };
  useEffect(() => { setPlan(undefined); setRecordPage(0); }, [pilot.document, pilot.profile, pilot.revisions, scope]);
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
    selectResources(resolution(resource).status === 'resolved' ? [resource] : selectionTargets(resources, resource), pilot.revisions, scope || undefined);
  }
  return <section className="h-full overflow-auto p-3 space-y-3" aria-label={t('semantic.title')}>
    <p className="text-sm text-muted-foreground">{t('semantic.description')}</p>
    <div className="flex flex-wrap gap-2">
      <button className={button} disabled={pilot.busy} onClick={() => void pilot.demo(true)}>{t('semantic.demo')}</button>
      <button className={button} disabled={pilot.busy} onClick={() => void pilot.demo(false)}>{t('semantic.recordsOnly')}</button>
    </div>
    <label className="block text-sm">{t('semantic.mode')}<select className={control} value={mode} onChange={e => setMode(e.target.value)}>
      {(['local', 'turtle', 'nquads', 'jsonld', 'json', 'sparql', 'construct'] as const).map(value => <option key={value} value={value}>{t(`semantic.${value}`)}</option>)}
    </select></label>
    {['local', 'turtle', 'nquads', 'jsonld'].includes(mode) ? <label className="block text-sm">{t('semantic.payload')}<textarea className={control} rows={7} value={payload} onChange={e => setPayload(e.target.value)} /></label>
      : <><label className="block text-sm">{t('semantic.endpoint')}<input className={control} type="url" value={endpoint} onChange={e => setEndpoint(e.target.value)} /></label>
        <label className="block text-sm">{t('semantic.host')}<input className={control} value={host} onChange={e => setHost(e.target.value)} /></label></>}
    {(mode === 'sparql' || mode === 'construct') && <><label className="block text-sm">{t('semantic.query')}<textarea className={control} rows={7} value={query} onChange={e => setQuery(e.target.value)} /></label>
      <details><summary>{t('semantic.mapping')}</summary>{Object.entries(mapping).map(([key, value]) => <label key={key} className="block text-sm">{key}
        <input className={control} value={value} onChange={e => setMapping({ ...mapping, [key]: e.target.value })} /></label>)}</details></>}
    <div className="flex gap-2"><button className={button} disabled={pilot.busy} onClick={() => void pilot.load(sourceInput)}>{t('semantic.run')}</button>
      {pilot.busy && <button className={button} onClick={pilot.cancel}>{t('semantic.cancel')}</button>}</div>
    {['json', 'sparql', 'construct'].includes(mode) && <details><summary>{t('semantic.authentication')}</summary>
      <label className="block text-sm">{t('semantic.bearer')}<input type="password" autoComplete="off" className={control} value={bearer} onChange={e => setBearer(e.target.value)} /></label>
      <label className="block text-sm">{t('semantic.relay')}<input className={control} value={relayProvider} onChange={e => setRelayProvider(e.target.value)} /></label>
    </details>}
    {['json', 'sparql', 'construct'].includes(mode) && <button className={button} disabled={pilot.busy || !host || !endpoint} onClick={() => void pilot.related(sourceInput)}>{t('semantic.querySelected')}</button>}
    <SemanticIdentityControls strategy={pilot.strategy} onStrategy={pilot.setStrategy} links={pilot.links} onLinks={pilot.setLinks} profile={pilot.profile} identityFields={pilot.identityFields} onIdentityFields={pilot.setIdentityFields} onError={pilot.setError} />
    <SemanticProfileControls profile={pilot.profile} onProfile={pilot.setProfile} onError={pilot.setError} />
    <details><summary>{t('semantic.workspace')}</summary>
      <button className={button} onClick={pilot.saveWorkspace}>{t('semantic.saveWorkspace')}</button>
      <button className={button} onClick={() => { setBearer(''); setHost(''); pilot.restoreWorkspace(); }}>{t('semantic.restoreWorkspace')}</button>
      <button className={button} onClick={() => { setBearer(''); setHost(''); pilot.restoreWorkspace(payload); }}>{t('semantic.importWorkspace')}</button>
      {pilot.queries.map(preset => <button className={button} key={preset.id} onClick={() => { setEndpoint(preset.endpoint); setQuery(preset.query ?? ''); setMode(preset.kind === 'select' ? 'sparql' : preset.kind); setMapping(preset.mapping ?? DEFAULT_MAPPING); setHost(''); setBearer(''); }}>{preset.id}: {preset.endpoint}</button>)}
    </details>
    {pilot.results && <SemanticResults results={pilot.results} mapping={pilot.resultMapping ?? mapping} revisions={pilot.revisions} scope={scope || undefined} onError={error => pilot.setError(String(error))} />}
    {pilot.diagnostic && <output className="block text-sm">{pilot.diagnostic}</output>}
    {pilot.error && <p role="alert" className="text-sm text-destructive">{pilot.error}</p>}
    {pilot.graph && !pilot.document && <details open><summary>{t('semantic.graph')}</summary>
      <SemanticValidationSummary report={pilot.report} />
      <label className="block text-sm">{t('semantic.graph')}<textarea className={control} rows={10} value={pilot.graph} onChange={e => pilot.setGraph(e.target.value)} /></label>
      <button className={button} disabled={pilot.busy} onClick={() => void pilot.validate(true)}>{t('semantic.validateGraph')}</button>
      <ul>{pilot.findings.map((finding, index) => <li key={index} className="text-xs break-all">{finding.engine}: {finding.resourceId} — {finding.path}: {finding.message}</li>)}</ul>
    </details>}
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
      <ul className="text-sm">{pilot.pendingRevisions.filter(link => !pilot.revisions.has(link.revision)).map(link => <li key={link.revision}><button onClick={() => setRevision(link.revision)}>{link.revision}: {t('semantic.mappingStatus.unscoped')}</button></li>)}{[...pilot.revisions].map(([uri, id]) => <li key={uri}>{uri} → {models.get(id)?.name ?? id}</li>)}</ul>
    </details>
    {pilot.document ? <>
      <p className="text-sm break-all">{t('semantic.source', { source: pilot.document.source })}</p>
      <p className="text-sm">{t(pilot.document.completeness === 'partial' ? 'semantic.partial' : 'semantic.complete')}</p>
      <div className="flex flex-wrap gap-2">
        <button className={button} onClick={() => selectResources(resources, pilot.revisions, scope || undefined)}>{t('semantic.selectAll')}</button>
        <button className={button} disabled={pilot.busy} onClick={() => void pilot.validate()}>{t('semantic.validate')}</button>
        <button className={button} disabled={pilot.busy} onClick={() => void pilot.exportBundle()}>{t('semantic.export')}</button>
      </div>
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={onlySelected} onChange={e => { setOnlySelected(e.target.checked); setRecordPage(0); }} />{t('semantic.selected')}</label>
      <table className="w-full text-sm"><thead><tr><th className="text-left">{t('semantic.label')}</th><th>{t('semantic.type')}</th><th>{t('semantic.status')}</th></tr></thead>
        <tbody>{visible.slice(recordPage * 50, recordPage * 50 + 50).map(resource => <tr key={resource.id} className={active === resource.id ? 'bg-muted' : ''}>
          <td><button className="p-2 text-left underline" aria-label={t('semantic.selectRecord', { label: resource.label })} onClick={() => choose(resource)}>{resource.label}</button></td>
          <td>{resource.type}</td><td>{t(`semantic.mappingStatus.${resolution(resource).status}`)}</td>
        </tr>)}</tbody></table>
      <div className="flex gap-2"><button className={button} disabled={recordPage === 0} onClick={() => setRecordPage(recordPage - 1)}>{t('semantic.resultsPrevious')}</button>
        <button className={button} disabled={(recordPage + 1) * 50 >= visible.length} onClick={() => setRecordPage(recordPage + 1)}>{t('semantic.resultsNext')}</button></div>
      {current && <details open><summary>{t('semantic.related')}: {current.label}</summary><pre className="overflow-auto text-xs">{JSON.stringify(relatedResources(resources, [current.id]), null, 2)}</pre></details>}
      <p className="text-sm text-muted-foreground">{t('semantic.projection')}</p>
      {editDenial && <p className="text-sm">{t(mutationDenialKey(editDenial))}</p>}
      <label className="block text-sm">{t('semantic.projectionMapping')}<select className={control} value={mappingId} onChange={e => { setMappingId(e.target.value); setPlan(undefined); }}>{PROJECTION_MAPPINGS.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.pset}.{candidate.property}</option>)}</select></label>
      <label className="block text-sm">{t('semantic.conflict')}<select className={control} value={policy} onChange={e => { setPolicy(e.target.value as ConflictPolicy); setPlan(undefined); }}>{(['error', 'skip', 'overwrite'] as const).map(value => <option key={value} value={value}>{t(`semantic.conflict.${value}`)}</option>)}</select></label>
      <button className={button} disabled={!!editDenial || !current || !product || resolution(current).status !== 'resolved'} onClick={() => {
        if (!current || !product || !pilot.document) return;
        try { setPlan(previewProjection({ mappingId, resource: current, product, revisions: pilot.revisions,
          source: pilot.document.source, profile: pilot.profile.id, profileVersion: pilot.profile.version,
          retrievedAt: pilot.retrievedAt, scope: scope || undefined, policy, unit: pilot.profile.fields[PROJECTION_MAPPINGS.find(candidate => candidate.id === mappingId)?.field ?? '']?.unit })); }
        catch (failure) { pilot.setError(String(failure)); }
      }}>{t('semantic.previewProjection')}</button>
      {plan && <div><pre className="overflow-auto text-xs">{JSON.stringify({ target: plan.ref, GlobalId: plan.targetGlobalId, revision: plan.revision,
        property: `${plan.mapping.pset}.${plan.mapping.property}`, previous: plan.previous, value: plan.value, unit: plan.mapping.unit, policy: plan.policy, skip: plan.skip }, null, 2)}</pre>
        <button className={button} disabled={!!editDenial} onClick={() => {
          try { applyProjection(plan, pilot.revisions, scope || undefined); setPlan(undefined); setMessage(t('semantic.projectionApplied')); }
          catch (failure) { pilot.setError(String(failure)); }
        }}>{t('semantic.applyProjection')}</button></div>}
      <h3 className="font-medium">{t('semantic.validation')}</h3>
      <SemanticValidationSummary report={pilot.report} />
      <ul className="space-y-2 text-sm">{pilot.findings.map((finding, index) =>
        <li key={index}><button className="text-left underline break-all" onClick={() => {
          const resource = resources.find(record => record.id === finding.resourceId); if (resource) choose(resource);
        }}>{finding.engine}: {finding.resourceId} — {finding.path}: {finding.message}</button></li>)}</ul>
      <details><summary>{t('semantic.graph')}</summary><label className="block text-sm">{t('semantic.graph')}<textarea className={control} rows={10} value={pilot.graph} onChange={e => pilot.setGraph(e.target.value)} /></label>
        <button className={button} disabled={pilot.busy} onClick={() => void pilot.validate(true)}>{t('semantic.validateGraph')}</button></details>

    </> : <p className="text-sm">{t('semantic.noRecords')}</p>}
  </section>;
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { loadSavedFilters } from '@/lib/search/saved-filters.js';
import { ownAppearanceQuery } from '@/lib/appearance/query-definition.js';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { AppearancePanelViewProps } from './types.js';
import { appearanceSelectClass } from './AppearanceSourceFields.js';
import { FaceMaskTargets } from './face-mask/FaceMaskTargets.js';

export function AppearanceScopeFields(props: Pick<AppearancePanelViewProps,
  'models' | 'modelId' | 'onModelChange' | 'scope' | 'onScopeChange' | 'classes' | 'types' |
  'settings' | 'onSettingsChange' | 'convertedObjects' | 'faceMasks' | 'selectionCount' | 'affectedCount' | 'excludedCount' | 'exclusions' | 'onUseSupported'> & { disabled: boolean }) {
  const id = useId();
  const [filters, setFilters] = useState(() => loadSavedFilters(ownAppearanceQuery));
  const currentName = props.scope.kind === 'filter' ? props.scope.query.name : undefined;
  const latest = filters.find(filter => filter.name === currentName);
  const changed = props.scope.kind === 'filter' && latest
    && JSON.stringify(ownAppearanceQuery(latest)) !== JSON.stringify(props.scope.query);
  return <section className="space-y-2" aria-labelledby={`${id}-heading`}>
    <h3 id={`${id}-heading`} className="text-xs font-medium">Apply to</h3>
    <label className="block space-y-1 text-[11px] text-muted-foreground"><span>Model</span>
      <select aria-label="Appearance model" className={appearanceSelectClass} value={props.modelId ?? ''} disabled={props.disabled || !props.models.length} onChange={event => props.onModelChange(event.target.value)}>
        {!props.modelId && <option value="">{props.models.length ? 'Choose a model' : 'Load an IFC model'}</option>}
        {props.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
      </select>
    </label>
    <select aria-label="Appearance scope" className={appearanceSelectClass} value={props.scope.kind} disabled={props.disabled || !props.modelId} onChange={event => {
      switch (event.target.value) {
        case 'model': props.onScopeChange({ kind: 'model' }); break;
        case 'selection': props.onScopeChange({ kind: 'selection' }); break;
        case 'class': props.onScopeChange({ kind: 'class', ifcClass: props.classes[0]?.value ?? '' }); break;
        case 'type': props.onScopeChange({ kind: 'type', typeId: props.types[0]?.id ?? 0 }); break;
        case 'filter': if (filters[0]) props.onScopeChange({ kind: 'filter', query: ownAppearanceQuery(filters[0]) }); break;
      }
    }}>
      <option value="model">Entire model</option>
      <option value="selection">Current selection ({props.selectionCount})</option>
      <option value="class" disabled={!props.classes.length}>IFC class</option>
      <option value="type" disabled={!props.types.length}>Exact IFC type</option>
      <option value="filter" disabled={!filters.length}>Saved filter</option>
    </select>
    {props.scope.kind === 'class' && <select aria-label="IFC class" className={appearanceSelectClass} value={props.scope.ifcClass} disabled={props.disabled} onChange={event => props.onScopeChange({ kind: 'class', ifcClass: event.target.value })}>
      {props.classes.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
    </select>}
    {props.scope.kind === 'type' && <select aria-label="Exact IFC type" className={appearanceSelectClass} value={props.scope.typeId} disabled={props.disabled} onChange={event => props.onScopeChange({ kind: 'type', typeId: Number(event.target.value) })}>
      {props.types.map(item => <option key={item.id} value={item.id}>{item.name} · #{item.id}</option>)}
    </select>}
    {props.scope.kind === 'filter' && <div className="space-y-1">
      <select aria-label="Appearance saved filter" className={appearanceSelectClass} value={props.scope.query.name}
        disabled={props.disabled} onChange={event => {
          const preset = filters.find(filter => filter.name === event.target.value);
          if (preset) props.onScopeChange({ kind: 'filter', query: ownAppearanceQuery(preset) });
        }}>
        {!filters.some(filter => filter.name === (props.scope.kind === 'filter' ? props.scope.query.name : ''))
          && <option value={props.scope.query.name}>{props.scope.query.name} (captured)</option>}
        {filters.map(filter => <option key={filter.name} value={filter.name}>{filter.name}</option>)}
      </select>
      {changed && latest && <Button type="button" size="sm" variant="outline" disabled={props.disabled}
        onClick={() => props.onScopeChange({ kind: 'filter', query: ownAppearanceQuery(latest) })}>Use updated filter</Button>}
      <p className="text-[11px] text-muted-foreground">The selected filter is copied into this draft. Preview and Apply use its captured membership in this model. Saved assignments review membership changes before reuse.</p>
    </div>}
    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
      <span>Save filters in Search to reuse them here.</span>
      <Button type="button" size="sm" variant="ghost" disabled={props.disabled}
        onClick={() => setFilters(loadSavedFilters(ownAppearanceQuery))}>Refresh filters</Button>
    </div>
    <label className="flex items-start gap-2 rounded-md border p-2 text-[11px]">
      <input type="checkbox" className="mt-0.5" checked={props.settings.representationPolicy === 'evaluatedOccurrence'}
        disabled={props.disabled || !props.modelId || props.settings.kind === 'existingUv'}
        onChange={event => props.onSettingsChange({ representationPolicy: event.target.checked ? 'evaluatedOccurrence' : 'preserve' })} />
      <span><span className="font-medium">Convert supported objects to mesh</span>
        <span className="mt-1 block text-muted-foreground">Their current shape, including existing openings, becomes fixed mesh geometry. Opening relationships remain, but their reference shapes no longer render or cut the mesh. Other occurrences stay unchanged. Undo restores the original geometry.</span>
        {props.settings.kind === 'existingUv' && <span className="mt-1 block text-muted-foreground">Choose planar or box mapping to enable conversion.</span>}
      </span>
    </label>
    <div className="rounded-md bg-muted/50 px-2.5 py-2 text-[11px]" aria-live="polite">
      <span className="font-medium">{props.affectedCount.toLocaleString()} {props.affectedCount === 1 ? 'object' : 'objects'} affected</span>
      {props.excludedCount > 0 && <span className="text-muted-foreground"> · {props.excludedCount.toLocaleString()} excluded</span>}
      {!!props.convertedObjects?.length && <details className="mt-1" open={!!props.faceMasks?.targets.length}><summary className="cursor-pointer font-medium">{props.convertedObjects.length} {props.convertedObjects.length === 1 ? 'object' : 'objects'} will become mesh geometry</summary>
        {props.faceMasks?.targets.length ? <div className="mt-1"><FaceMaskTargets controls={props.faceMasks} disabled={props.disabled} /></div>
          : <ul className="mt-1 max-h-28 space-y-1 overflow-y-auto text-muted-foreground">{props.convertedObjects.map(item => <li key={item.productId}>{item.name}</li>)}</ul>}
      </details>}
      {!!props.faceMasks?.diagnostics.length && !props.faceMasks.targets.length && <ul className="mt-1 space-y-1 text-destructive" role="alert" aria-label="Face selection diagnostics">
        {props.faceMasks.diagnostics.map((message, index) => <li key={`${index}:${message}`}>{message}</li>)}</ul>}
      {!!props.exclusions?.length && <details className="mt-1 text-muted-foreground"><summary className="cursor-pointer">Why some objects are excluded</summary><ul className="mt-1 space-y-1">{props.exclusions.map((reason, index) => <li key={`${index}:${reason}`}>{reason}</li>)}</ul></details>}
      {props.affectedCount > 0 && props.excludedCount > 0 && props.onUseSupported && <Button type="button" variant="outline" size="sm" className="mt-2 w-full" disabled={props.disabled} onClick={props.onUseSupported}>Use supported objects</Button>}
    </div>
  </section>;
}

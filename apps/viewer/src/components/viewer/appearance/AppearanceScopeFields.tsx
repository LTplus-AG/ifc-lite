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
import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';

export function AppearanceScopeFields(props: Pick<AppearancePanelViewProps,
  'models' | 'modelId' | 'onModelChange' | 'scope' | 'onScopeChange' | 'classes' | 'types' |
  'settings' | 'onSettingsChange' | 'convertedObjects' | 'faceMasks' | 'selectionCount' | 'affectedCount' | 'excludedCount' | 'exclusions' | 'onUseSupported'> & { disabled: boolean }) {
  const { t, locale } = useTranslation();
  const id = useId();
  const [filters, setFilters] = useState(() => loadSavedFilters(ownAppearanceQuery));
  const currentName = props.scope.kind === 'filter' ? props.scope.query.name : undefined;
  const latest = filters.find(filter => filter.name === currentName);
  const changed = props.scope.kind === 'filter' && latest
    && JSON.stringify(ownAppearanceQuery(latest)) !== JSON.stringify(props.scope.query);
  // While a re-plan runs the converted list is empty, but the face-selection
  // editors keep their surfaces: staying mounted keeps their renderers and cameras.
  const converted = props.convertedObjects?.length ? props.convertedObjects
    : (props.faceMasks?.targets ?? []).map(target => ({ productId: target.productId, name: target.label }));
  return <section className="space-y-2" aria-labelledby={`${id}-heading`}>
    <h3 id={`${id}-heading`} className="text-xs font-medium">{t('appearance.scopeFields.heading')}</h3>
    <label className="block space-y-1 text-2xs text-muted-foreground"><span>{t('appearance.scopeFields.modelLabel')}</span>
      <select aria-label={t('appearance.scopeFields.modelAriaLabel')} className={appearanceSelectClass} value={props.modelId ?? ''} disabled={props.disabled || !props.models.length} onChange={event => props.onModelChange(event.target.value)}>
        {!props.modelId && <option value="">{props.models.length ? t('appearance.scopeFields.chooseModel') : t('appearance.scopeFields.loadIfcModel')}</option>}
        {props.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
      </select>
    </label>
    <select aria-label={t('appearance.scopeFields.scopeAriaLabel')} className={appearanceSelectClass} value={props.scope.kind} disabled={props.disabled || !props.modelId} onChange={event => {
      switch (event.target.value) {
        case 'model': props.onScopeChange({ kind: 'model' }); break;
        case 'selection': props.onScopeChange({ kind: 'selection' }); break;
        case 'class': props.onScopeChange({ kind: 'class', ifcClass: props.classes[0]?.value ?? '' }); break;
        case 'type': props.onScopeChange({ kind: 'type', typeId: props.types[0]?.id ?? 0 }); break;
        case 'filter': if (filters[0]) props.onScopeChange({ kind: 'filter', query: ownAppearanceQuery(filters[0]) }); break;
      }
    }}>
      <option value="model">{t('appearance.scopeFields.entireModel')}</option>
      <option value="selection">{t('appearance.scopeFields.currentSelection', { count: formatLocaleNumber(locale, props.selectionCount) })}</option>
      <option value="class" disabled={!props.classes.length}>{t('appearance.scopeFields.ifcClassOption')}</option>
      <option value="type" disabled={!props.types.length}>{t('appearance.scopeFields.exactIfcTypeOption')}</option>
      <option value="filter" disabled={!filters.length}>{t('appearance.scopeFields.savedFilterOption')}</option>
    </select>
    {props.scope.kind === 'class' && <select aria-label={t('appearance.scopeFields.ifcClassAriaLabel')} className={appearanceSelectClass} value={props.scope.ifcClass} disabled={props.disabled} onChange={event => props.onScopeChange({ kind: 'class', ifcClass: event.target.value })}>
      {props.classes.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
    </select>}
    {props.scope.kind === 'type' && <select aria-label={t('appearance.scopeFields.exactIfcTypeAriaLabel')} className={appearanceSelectClass} value={props.scope.typeId} disabled={props.disabled} onChange={event => props.onScopeChange({ kind: 'type', typeId: Number(event.target.value) })}>
      {props.types.map(item => <option key={item.id} value={item.id}>{item.name} · #{item.id}</option>)}
    </select>}
    {props.scope.kind === 'filter' && <div className="space-y-1">
      <select aria-label={t('appearance.scopeFields.savedFilterAriaLabel')} className={appearanceSelectClass} value={props.scope.query.name}
        disabled={props.disabled} onChange={event => {
          const preset = filters.find(filter => filter.name === event.target.value);
          if (preset) props.onScopeChange({ kind: 'filter', query: ownAppearanceQuery(preset) });
        }}>
        {!filters.some(filter => filter.name === (props.scope.kind === 'filter' ? props.scope.query.name : ''))
          && <option value={props.scope.query.name}>{t('appearance.scopeFields.capturedFilterOption', { name: props.scope.query.name })}</option>}
        {filters.map(filter => <option key={filter.name} value={filter.name}>{filter.name}</option>)}
      </select>
      {changed && latest && <Button type="button" size="sm" variant="outline" disabled={props.disabled}
        onClick={() => props.onScopeChange({ kind: 'filter', query: ownAppearanceQuery(latest) })}>{t('appearance.scopeFields.useUpdatedFilter')}</Button>}
      <p className="text-2xs text-muted-foreground">{t('appearance.scopeFields.filterNote')}</p>
    </div>}
    <div className="flex items-center gap-2 text-2xs text-muted-foreground">
      <span>{t('appearance.scopeFields.saveFiltersHint')}</span>
      <Button type="button" size="sm" variant="ghost" disabled={props.disabled}
        onClick={() => setFilters(loadSavedFilters(ownAppearanceQuery))}>{t('appearance.scopeFields.refreshFilters')}</Button>
    </div>
    <label className="flex items-start gap-2 rounded-md border p-2 text-2xs">
      <input type="checkbox" className="mt-0.5" checked={props.settings.representationPolicy === 'evaluatedOccurrence'}
        disabled={props.disabled || !props.modelId || props.settings.kind === 'existingUv'}
        onChange={event => props.onSettingsChange({ representationPolicy: event.target.checked ? 'evaluatedOccurrence' : 'preserve' })} />
      <span><span className="font-medium">{t('appearance.scopeFields.convertToMesh')}</span>
        <span className="mt-1 block text-muted-foreground">{t('appearance.scopeFields.convertToMeshNote')}</span>
        {props.settings.kind === 'existingUv' && <span className="mt-1 block text-muted-foreground">{t('appearance.scopeFields.existingUvNote')}</span>}
      </span>
    </label>
    <div className="rounded-md bg-muted/50 px-2.5 py-2 text-2xs" aria-live="polite">
      <span className="font-medium">{t('appearance.scopeFields.affectedCount', {
        count: props.affectedCount,
        countDisplay: formatLocaleNumber(locale, props.affectedCount),
      })}</span>
      {props.excludedCount > 0 && <span className="text-muted-foreground"> · {t('appearance.scopeFields.excludedCount', { count: formatLocaleNumber(locale, props.excludedCount) })}</span>}
      {!!converted.length && <details className="mt-1" open={!!props.faceMasks?.targets.length}><summary className="cursor-pointer font-medium">{t('appearance.scopeFields.convertedSummary', {
        count: converted.length,
        countDisplay: formatLocaleNumber(locale, converted.length),
      })}</summary>
        {props.faceMasks?.targets.length ? <div className="mt-1"><FaceMaskTargets controls={props.faceMasks} disabled={props.disabled} /></div>
          : <ul className="mt-1 max-h-28 space-y-1 overflow-y-auto text-muted-foreground">{converted.map(item => <li key={item.productId}>{item.name}</li>)}</ul>}
      </details>}
      {!!props.faceMasks?.diagnostics.length && !props.faceMasks.targets.length && <ul className="mt-1 space-y-1 text-destructive" role="alert" aria-label={t('appearance.faceMask.diagnosticsAriaLabel')}>
        {props.faceMasks.diagnostics.map((message, index) => <li key={`${index}:${message}`}>{message}</li>)}</ul>}
      {!!props.exclusions?.length && <details className="mt-1 text-muted-foreground"><summary className="cursor-pointer">{t('appearance.scopeFields.exclusionReasonsSummary')}</summary><ul className="mt-1 space-y-1">{props.exclusions.map((reason, index) => <li key={`${index}:${reason}`}>{reason}</li>)}</ul></details>}
      {props.affectedCount > 0 && props.excludedCount > 0 && props.onUseSupported && <Button type="button" variant="outline" size="sm" className="mt-2 w-full" disabled={props.disabled} onClick={props.onUseSupported}>{t('appearance.scopeFields.useSupportedObjects')}</Button>}
    </div>
  </section>;
}

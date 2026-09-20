/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The chart editor's IFC field picker (#4833): a family (attribute, property,
 * quantity, or a relation such as material / classification / type / spatial
 * container), then the set and the field. A filter box narrows set and field
 * names, because an authoring-tool export easily carries hundreds of psets.
 */
import { useState } from 'react';
import { elementFieldColumnId, type ElementFieldBinding } from '@ifc-lite/charts';
import { useTranslation } from '@/i18n/useTranslation';
import type { ElementFieldCatalog, ElementFieldOption } from '@/lib/charts/element-field-reader';

export interface ElementFieldPickerProps {
  value?: ElementFieldBinding;
  catalog: ElementFieldCatalog;
  loading: boolean;
  className: string;
  onChange: (value: ElementFieldBinding | undefined) => void;
}

type Family = 'built-in' | 'attribute' | 'property' | 'quantity' | 'relation';

const FAMILY_LABELS: Record<Family, string> = {
  'built-in': 'Built-in columns',
  attribute: 'IFC attribute',
  property: 'IFC property',
  quantity: 'IFC quantity',
  relation: 'Material / classification / type / spatial',
};

function familyOf(binding: ElementFieldBinding | undefined): Family {
  if (!binding) return 'built-in';
  if (binding.kind === 'attribute' || binding.kind === 'property' || binding.kind === 'quantity') return binding.kind;
  return 'relation';
}

function optionText(option: ElementFieldOption): string {
  const name = option.binding.kind === 'property' ? option.binding.propertyName
    : option.binding.kind === 'quantity' ? option.binding.quantityName
      : option.label;
  return `${name}${option.observedValue ? '' : ' (no values)'}`;
}

const matches = (filter: string, text: string): boolean => filter === '' || text.toLowerCase().includes(filter);

/**
 * The sets a filter leaves visible, with the fields visible inside each: a
 * set whose own name matches keeps every field; otherwise only matching
 * fields, and a set with none left is hidden.
 */
export function filterSets(sets: ReadonlyMap<string, ElementFieldOption[]>, filter: string): Map<string, ElementFieldOption[]> {
  const needle = filter.trim().toLowerCase();
  const out = new Map<string, ElementFieldOption[]>();
  for (const [name, options] of sets) {
    if (matches(needle, name)) { out.set(name, options); continue; }
    const kept = options.filter((option) => matches(needle, optionText(option)));
    if (kept.length > 0) out.set(name, kept);
  }
  return out;
}

export function ElementFieldPicker({ value, catalog, loading, className, onChange }: ElementFieldPickerProps) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState('');
  const family = familyOf(value);
  const needle = filter.trim().toLowerCase();
  const valueId = value ? elementFieldColumnId(value) : '';

  const sets = family === 'property' ? catalog.properties : family === 'quantity' ? catalog.quantities : undefined;
  const visibleSets = sets ? filterSets(sets, filter) : new Map<string, ElementFieldOption[]>();
  const chosenSet = value?.kind === 'property' ? value.psetName : value?.kind === 'quantity' ? value.qsetName : '';
  // With a filter active, a set none of whose fields match lists nothing; the
  // saved selection is kept through the separate "(unavailable)" option.
  const setOptions = visibleSets.get(chosenSet) ?? [];
  const attributeOptions = catalog.attributes.filter((option) => matches(needle, optionText(option)));
  const relationOptions = catalog.relations.filter((option) => matches(needle, optionText(option)));
  const flatOptions = family === 'attribute' ? attributeOptions : family === 'relation' ? relationOptions : setOptions;
  const selectedAvailable = flatOptions.some((option) => elementFieldColumnId(option.binding) === valueId);
  const firstOf = (options: readonly ElementFieldOption[] | undefined): ElementFieldBinding | undefined => options?.[0]?.binding;

  const setFamily = (next: Family): void => {
    if (next === 'built-in') onChange(undefined);
    else if (next === 'attribute') onChange(firstOf(catalog.attributes));
    else if (next === 'relation') onChange(firstOf(catalog.relations));
    else onChange(firstOf((next === 'property' ? catalog.properties : catalog.quantities).values().next().value));
  };
  const familyEmpty = (candidate: Family): boolean => {
    if (candidate === 'built-in') return false;
    if (candidate === 'attribute') return catalog.attributes.length === 0;
    if (candidate === 'relation') return catalog.relations.length === 0;
    return (candidate === 'property' ? catalog.properties : catalog.quantities).size === 0;
  };
  const selectId = (options: readonly ElementFieldOption[], id: string): void =>
    onChange(options.find((option) => elementFieldColumnId(option.binding) === id)?.binding);

  return (
    <div className="col-span-2 grid grid-cols-2 gap-2" data-element-field-picker>
      <label className="flex flex-col gap-0.5">
        <span className="text-muted-foreground">{loading ? t('elementFieldPicker.fieldLabelLoading') : t('elementFieldPicker.fieldLabel')}</span>
        <select className={className} value={family} onChange={(event) => setFamily(event.target.value as Family)} aria-label={t('elementFieldPicker.fieldSourceAriaLabel')}>
          {(Object.keys(FAMILY_LABELS) as Family[]).map((candidate) => (
            <option key={candidate} value={candidate} disabled={familyEmpty(candidate) && family !== candidate}>{FAMILY_LABELS[candidate]}</option>
          ))}
        </select>
      </label>
      {family !== 'built-in' && (
        <label className="flex flex-col gap-0.5">
          <span className="text-muted-foreground">{t('elementFieldPicker.filterLabel')}</span>
          <input className={className} value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={t('elementFieldPicker.filterPlaceholder')} aria-label={t('elementFieldPicker.filterAriaLabel')} />
        </label>
      )}
      {family === 'attribute' && (
        <label className="flex flex-col gap-0.5">
          <span className="text-muted-foreground">{t('elementFieldPicker.attributeLabel')}</span>
          <select className={className} value={valueId} onChange={(event) => selectId(catalog.attributes, event.target.value)} aria-label={t('elementFieldPicker.attributeAriaLabel')}>
            {!selectedAvailable && value && <option value={valueId}>{t('elementFieldPicker.unavailableAttributeOption', { name: value.kind === 'attribute' ? value.attributeName : '' })}</option>}
            {attributeOptions.map((option) => <option key={elementFieldColumnId(option.binding)} value={elementFieldColumnId(option.binding)}>{optionText(option)}</option>)}
          </select>
        </label>
      )}
      {(family === 'property' || family === 'quantity') && sets && (
        <>
          <label className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">{family === 'property' ? t('elementFieldPicker.propertySetLabel') : t('elementFieldPicker.quantitySetLabel')}</span>
            <select className={className} value={chosenSet} onChange={(event) => onChange(firstOf(visibleSets.get(event.target.value) ?? sets.get(event.target.value)))} aria-label={family === 'property' ? t('elementFieldPicker.propertySetAriaLabel') : t('elementFieldPicker.quantitySetAriaLabel')}>
              {!visibleSets.has(chosenSet) && <option value={chosenSet}>{sets.has(chosenSet) ? chosenSet : t('elementFieldPicker.unavailableSetOption', { name: chosenSet })}</option>}
              {[...visibleSets.keys()].map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">{family === 'property' ? t('elementFieldPicker.propertyLabel') : t('elementFieldPicker.quantityLabel')}</span>
            <select className={className} value={valueId} onChange={(event) => selectId(sets.get(chosenSet) ?? [], event.target.value)} aria-label={family === 'property' ? t('elementFieldPicker.propertyAriaLabel') : t('elementFieldPicker.quantityAriaLabel')}>
              {!selectedAvailable && value && <option value={valueId}>{t('elementFieldPicker.unavailableFieldOption', { name: value.kind === 'property' ? value.propertyName : value.kind === 'quantity' ? value.quantityName : '' })}</option>}
              {setOptions.map((option) => <option key={elementFieldColumnId(option.binding)} value={elementFieldColumnId(option.binding)}>{optionText(option)}</option>)}
            </select>
          </label>
        </>
      )}
      {family === 'relation' && (
        <label className="flex flex-col gap-0.5">
          <span className="text-muted-foreground">{t('elementFieldPicker.relationLabel')}</span>
          <select className={className} value={valueId} onChange={(event) => selectId(catalog.relations, event.target.value)} aria-label={t('elementFieldPicker.relationAriaLabel')}>
            {!selectedAvailable && value && (
              <option value={valueId}>
                {t('elementFieldPicker.unavailableRelationOption', {
                  name: value.kind === 'classification' && value.system ? t('elementFieldPicker.classificationName', { system: value.system }) : value.kind,
                })}
              </option>
            )}
            {relationOptions.map((option) => <option key={elementFieldColumnId(option.binding)} value={elementFieldColumnId(option.binding)}>{optionText(option)}</option>)}
          </select>
        </label>
      )}
      {value && !loading && !selectedAvailable && needle === '' && (
        <p className="col-span-2 text-amber-600" role="status">{t('elementFieldPicker.unavailableFieldNotice')}</p>
      )}
    </div>
  );
}

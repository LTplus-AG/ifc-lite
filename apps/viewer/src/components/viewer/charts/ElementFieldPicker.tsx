/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { elementFieldColumnId } from '@ifc-lite/charts';
import type { ElementFieldCatalog, ElementFieldOption } from '@/lib/charts/element-field-reader';
import type { ElementFieldBinding } from '@ifc-lite/charts';

export interface ElementFieldPickerProps {
  value?: ElementFieldBinding;
  catalog: ElementFieldCatalog;
  loading: boolean;
  className: string;
  onChange: (value: ElementFieldBinding | undefined) => void;
}

export function ElementFieldPicker({ value, catalog, loading, className, onChange }: ElementFieldPickerProps) {
  const mode = value?.kind ?? 'built-in';
  const propertySets = [...catalog.properties.keys()];
  const chosenSet = value?.kind === 'property' ? value.psetName : (propertySets[0] ?? '');
  const propertyOptions = catalog.properties.get(chosenSet) ?? [];
  const attributeId = value?.kind === 'attribute' ? elementFieldColumnId(value) : '';
  const propertyId = value?.kind === 'property' ? elementFieldColumnId(value) : '';
  const selectedAttributeAvailable = catalog.attributes.some((option) => elementFieldColumnId(option.binding) === attributeId);
  const selectedPropertyAvailable = propertyOptions.some((option) => elementFieldColumnId(option.binding) === propertyId);

  return (
    <div className="col-span-2 grid grid-cols-2 gap-2" data-element-field-picker>
      <label className="flex flex-col gap-0.5">
        <span className="text-muted-foreground">Element field{loading ? ' (discovering…)' : ''}</span>
        <select
          className={className}
          value={mode}
          onChange={(event) => {
            const next = event.target.value;
            if (next === 'built-in') onChange(undefined);
            else if (next === 'attribute') onChange(catalog.attributes[0]?.binding);
            else {
              const firstSet = catalog.properties.values().next().value as ElementFieldOption[] | undefined;
              onChange(firstSet?.[0]?.binding);
            }
          }}
          aria-label="Element field source"
        >
          <option value="built-in">Built-in columns</option>
          <option value="attribute" disabled={catalog.attributes.length === 0 && value?.kind !== 'attribute'}>IFC attribute</option>
          <option value="property" disabled={catalog.properties.size === 0 && value?.kind !== 'property'}>IFC property</option>
        </select>
      </label>
      {value?.kind === 'attribute' && (
        <label className="flex flex-col gap-0.5">
          <span className="text-muted-foreground">Attribute</span>
          <select className={className} value={attributeId} onChange={(event) => onChange(catalog.attributes.find((option) => elementFieldColumnId(option.binding) === event.target.value)?.binding)} aria-label="IFC attribute">
            {!selectedAttributeAvailable && <option value={attributeId}>{value.attributeName} (unavailable)</option>}
            {catalog.attributes.map((option) => <option key={elementFieldColumnId(option.binding)} value={elementFieldColumnId(option.binding)}>{option.label}</option>)}
          </select>
        </label>
      )}
      {value?.kind === 'property' && (
        <>
          <label className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">Property set</span>
            <select className={className} value={chosenSet} onChange={(event) => onChange(catalog.properties.get(event.target.value)?.[0]?.binding)} aria-label="IFC property set">
              {!catalog.properties.has(chosenSet) && <option value={chosenSet}>{chosenSet} (unavailable)</option>}
              {propertySets.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">Property</span>
            <select className={className} value={propertyId} onChange={(event) => onChange(propertyOptions.find((option) => elementFieldColumnId(option.binding) === event.target.value)?.binding)} aria-label="IFC property">
              {!selectedPropertyAvailable && <option value={propertyId}>{value.propertyName} (unavailable)</option>}
              {propertyOptions.map((option) => <option key={elementFieldColumnId(option.binding)} value={elementFieldColumnId(option.binding)}>{option.binding.kind === 'property' ? option.binding.propertyName : option.label}</option>)}
            </select>
          </label>
        </>
      )}
      {value && !loading && ((value.kind === 'attribute' && !selectedAttributeAvailable) || (value.kind === 'property' && !selectedPropertyAvailable)) && (
        <p className="col-span-2 text-amber-600" role="status">This saved field is unavailable in the loaded models. It will be preserved.</p>
      )}
    </div>
  );
}

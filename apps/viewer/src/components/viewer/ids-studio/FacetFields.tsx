/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Field editors per facet type (IDS-033, IDS-034). Every change is an op batch
 * handed to `dispatch`; pickers read the gate's own schema tables, so a name
 * offered here is a name the gate accepts for the spec's IFC versions.
 */

import { useMemo, useState } from 'react';
import type { IDSFacet, IFCVersion, PartOfRelation } from '@ifc-lite/ids';
import { type FacetFieldName, type GateContext, type StudioOp, type Uuid, type ValueInput } from '@ifc-lite/ids-authoring';
import { useTranslation } from '@/i18n';
import { addEnumValueOp, removeEnumValueOp, setFieldOp, setRelationOp } from '@/lib/ids-studio/ops';
import {
  attributeOptions, dataTypeBase, dataTypeOptions, entityOptions, findEntity, propertyOptions, psetOptions,
} from '@/lib/ids-studio/schema-pickers';
import { siUnitOf } from '@/lib/ids-studio/units';
import { NameField } from './NameField';
import type { PickerOption } from './NamePicker';
import { ValueEditor } from './ValueEditor';

export interface FacetFieldsProps {
  facet: IDSFacet;
  facetId: Uuid;
  gate: GateContext;
  versions: readonly IFCVersion[];
  /** Literal entity names of the spec's applicability (for attribute and pset filtering). */
  entities: readonly string[];
  dispatch: (ops: StudioOp[]) => void;
}

const PART_OF_RELATIONS: readonly PartOfRelation[] = [
  'IfcRelAggregates', 'IfcRelAssignsToGroup', 'IfcRelContainedInSpatialStructure', 'IfcRelNests',
  'IfcRelVoidsElement', 'IfcRelFillsElement', 'IfcRelVoidsElement IfcRelFillsElement',
];

const equals = (value: string): ValueInput => ({ kind: 'equals', value });

function useEntityOptions(gate: GateContext, versions: readonly IFCVersion[], abstractLabel: string): PickerOption[] {
  return useMemo(() => entityOptions(gate, versions).map((e) => ({
    value: e.name,
    detail: e.ancestors.slice(0, 2).join(' › '),
    ...(e.abstract ? { badges: [{ label: abstractLabel, tone: 'warn' as const }], dim: true } : {}),
  })), [gate, versions, abstractLabel]);
}

/** Schema spelling of an upper-case stored entity name (`IFCWALL` → `IfcWall`). */
function entityDisplay(gate: GateContext, versions: readonly IFCVersion[]) {
  return (stored: string) => findEntity(gate, versions, stored)?.name ?? stored;
}

function EntityFields({ facet, facetId, gate, versions, dispatch, prefix }: FacetFieldsProps & { prefix: 'entity' | 'partOf.entity' }) {
  const { t } = useTranslation();
  const entityFacet = facet.type === 'partOf' ? facet.entity : facet.type === 'entity' ? facet : undefined;
  const options = useEntityOptions(gate, versions, t('idsStudio.picker.abstract'));
  const name = entityFacet?.name.type === 'simpleValue' ? entityFacet.name.value : undefined;
  const entity = name ? findEntity(gate, versions, name) : undefined;
  const predefined = useMemo<PickerOption[]>(() => (entity?.predefinedTypes ?? []).map((value) => ({ value })), [entity]);
  const set = (field: FacetFieldName, value: ValueInput | null) => dispatch([setFieldOp(facetId, field, value)]);
  return <>
    <NameField label={t('idsStudio.field.entity')} required constraint={entityFacet?.name} options={options}
      display={entityDisplay(gate, versions)} onPick={(v) => set(`${prefix}.name` as FacetFieldName, equals(v))}
      onCommit={(input) => set(`${prefix}.name` as FacetFieldName, input)} />
    {entity?.abstract && <p className="text-2xs text-amber-700 dark:text-amber-400">{t('idsStudio.field.abstractHint', { entity: entity.name })}</p>}
    <NameField label={t('idsStudio.field.predefinedType')} constraint={entityFacet?.predefinedType} options={predefined}
      onPick={(v) => set(`${prefix}.predefinedType` as FacetFieldName, equals(v))}
      onCommit={(input) => set(`${prefix}.predefinedType` as FacetFieldName, input)} />
  </>;
}

function PropertyFields({ facet, facetId, gate, versions, entities, dispatch }: FacetFieldsProps) {
  const { t } = useTranslation();
  const [showAll, setShowAll] = useState(entities.length === 0);
  if (facet.type !== 'property') return null;
  const psetName = facet.propertySet.type === 'simpleValue' ? facet.propertySet.value : undefined;
  const dataType = facet.dataType?.type === 'simpleValue' ? facet.dataType.value : undefined;
  const applicable = t('idsStudio.picker.applicable');
  const psets: PickerOption[] = psetOptions(gate, versions, entities, showAll).map((p) => ({
    value: p.name, ...(p.applicable ? { badges: [{ label: applicable, tone: 'ok' as const }] } : {}), dim: entities.length > 0 && !p.applicable,
  }));
  const properties = psetName ? propertyOptions(gate, versions, psetName) : [];
  const propertyPicks: PickerOption[] = properties.map((p) => ({ value: p.name, ...(p.dataType ? { detail: p.dataType } : {}) }));
  const set = (field: FacetFieldName, value: ValueInput | null, extra: StudioOp[] = []) => dispatch([...extra, setFieldOp(facetId, field, value)]);
  // A non-standard set is refused by the gate (GATE-CUST-001); the rejection
  // banner offers to declare it as custom, deliberately, in the same undo step.
  const pickPset = (name: string) => set('property.propertySet', equals(name));
  const pickProperty = (name: string) => {
    const schemaType = properties.find((p) => p.name === name)?.dataType;
    // Fill the data type from the schema when none is set, in the same batch.
    const extra = schemaType && !facet.dataType ? [setFieldOp(facetId, 'property.dataType', equals(schemaType))] : [];
    dispatch([setFieldOp(facetId, 'property.baseName', equals(name)), ...extra]);
  };
  const showAllToggle = entities.length > 0 && <label className="flex items-center gap-1 text-2xs text-muted-foreground">
    <input type="checkbox" checked={showAll} onChange={(event) => setShowAll(event.target.checked)} />{t('idsStudio.picker.showAll')}
  </label>;
  return <>
    <NameField label={t('idsStudio.field.propertySet')} required constraint={facet.propertySet} options={psets} labelAction={showAllToggle}
      onPick={pickPset} onCommit={(input) => set('property.propertySet', input)} />
    <NameField label={t('idsStudio.field.property')} required constraint={facet.baseName} options={propertyPicks}
      onPick={pickProperty} onCommit={(input) => set('property.baseName', input)} />
    <NameField label={t('idsStudio.field.dataType')} constraint={facet.dataType} options={dataTypeOptions(gate, versions).map((value) => ({ value }))}
      onPick={(v) => set('property.dataType', equals(v))} onCommit={(input) => set('property.dataType', input)} />
    <ValueEditor label={t('idsStudio.field.value')} constraint={facet.value}
      base={dataType ? dataTypeBase(gate, versions, dataType) : undefined} siUnit={siUnitOf(dataType)}
      onCommit={(input) => set('property.value', input)}
      onAddEnum={(v) => dispatch([addEnumValueOp(facetId, 'property.value', v)])}
      onRemoveEnum={(v) => dispatch([removeEnumValueOp(facetId, 'property.value', v)])} />
  </>;
}

export function FacetFields(props: FacetFieldsProps) {
  const { t } = useTranslation();
  const { facet, facetId, gate, versions, entities, dispatch } = props;
  const set = (field: FacetFieldName, value: ValueInput | null) => dispatch([setFieldOp(facetId, field, value)]);
  const enumOps = (field: FacetFieldName) => ({
    onAddEnum: (v: string) => dispatch([addEnumValueOp(facetId, field, v)]),
    onRemoveEnum: (v: string) => dispatch([removeEnumValueOp(facetId, field, v)]),
  });
  switch (facet.type) {
    case 'entity': return <EntityFields {...props} prefix="entity" />;
    case 'property': return <PropertyFields {...props} />;
    case 'attribute': return <>
      <NameField label={t('idsStudio.field.attribute')} required constraint={facet.name}
        options={attributeOptions(gate, versions, entities).map((value) => ({ value }))}
        onPick={(v) => set('attribute.name', equals(v))} onCommit={(input) => set('attribute.name', input)} />
      <ValueEditor label={t('idsStudio.field.value')} constraint={facet.value} onCommit={(input) => set('attribute.value', input)} {...enumOps('attribute.value')} />
    </>;
    case 'classification': return <>
      <ValueEditor label={t('idsStudio.field.system')} constraint={facet.system} onCommit={(input) => set('classification.system', input)} {...enumOps('classification.system')} />
      <ValueEditor label={t('idsStudio.field.code')} constraint={facet.value} onCommit={(input) => set('classification.value', input)} {...enumOps('classification.value')} />
    </>;
    case 'material': return <ValueEditor label={t('idsStudio.field.material')} constraint={facet.value}
      onCommit={(input) => set('material.value', input)} {...enumOps('material.value')} />;
    case 'partOf': return <>
      <div className="space-y-0.5">
        <label htmlFor={`${facetId}-relation`} className="block text-2xs text-muted-foreground">{t('idsStudio.field.relation')}</label>
        <select id={`${facetId}-relation`} className="h-7 w-full rounded border border-input bg-background px-1 text-xs" value={facet.relation}
          onChange={(event) => dispatch([setRelationOp(facetId, event.target.value as PartOfRelation)])}>
          {PART_OF_RELATIONS.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </div>
      <EntityFields {...props} prefix="partOf.entity" />
    </>;
  }
}

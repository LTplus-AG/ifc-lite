/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Adding a facet (IDS-033): pick the facet type, fill the fields IDS cannot do
 * without (entity name, attribute name, property set + property, partOf
 * entity), then ONE `facet.add` op goes through the gate. The local form is
 * UI state, not document state; nothing is written until "Add".
 */

import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import type { FacetType, IFCVersion, PartOfRelation } from '@ifc-lite/ids';
import type { FacetDraft, Section, Uuid } from '@ifc-lite/ids-authoring';
import { Button } from '@/components/ui/button';
import { useTranslation, type TranslationKey } from '@/i18n';
import { useViewerStore } from '@/store';
import { addFacetOps } from '@/lib/ids-studio/ops';
import { applicabilityEntities } from '@/lib/ids-studio/spec-entities';
import { attributeOptions, entityOptions, propertyOptions, psetOptions } from '@/lib/ids-studio/schema-pickers';
import { NamePicker } from './NamePicker';

export const FACET_TYPES: readonly FacetType[] = ['entity', 'attribute', 'property', 'classification', 'material', 'partOf'];
export const FACET_LABEL: Record<FacetType, TranslationKey> = {
  entity: 'idsStudio.facet.entity', attribute: 'idsStudio.facet.attribute', property: 'idsStudio.facet.property',
  classification: 'idsStudio.facet.classification', material: 'idsStudio.facet.material', partOf: 'idsStudio.facet.partOf',
};

interface DraftState { type: FacetType; name: string; pset: string; property: string; dataType?: string; relation: PartOfRelation }

function toDraft(state: DraftState): FacetDraft | null {
  const eq = (value: string) => ({ kind: 'equals' as const, value });
  switch (state.type) {
    case 'entity': return state.name ? { type: 'entity', name: eq(state.name) } : null;
    case 'attribute': return state.name ? { type: 'attribute', name: eq(state.name) } : null;
    case 'property': return state.pset && state.property
      ? { type: 'property', propertySet: eq(state.pset), baseName: eq(state.property), ...(state.dataType ? { dataType: eq(state.dataType) } : {}) }
      : null;
    case 'classification': return { type: 'classification' };
    case 'material': return { type: 'material' };
    case 'partOf': return state.name ? { type: 'partOf', relation: state.relation, entity: { name: eq(state.name) } } : null;
  }
}

export function AddFacetMenu({ specId, section }: { specId: Uuid; section: Section }) {
  const { t } = useTranslation();
  const doc = useViewerStore((s) => s.idsStudioState?.doc ?? null);
  const gate = useViewerStore((s) => s.idsStudioContexts?.gate ?? null);
  const dispatch = useViewerStore((s) => s.idsStudioDispatch);
  const select = useViewerStore((s) => s.idsStudioSelect);
  const [state, setState] = useState<DraftState | null>(null);
  const specIndex = doc ? doc.nodes.specs.findIndex((n) => n.id === specId) : -1;
  const spec = doc && specIndex >= 0 ? doc.ids.specifications[specIndex] : undefined;
  const versions: readonly IFCVersion[] = spec?.ifcVersions ?? [];
  const entities = useMemo(() => (spec ? applicabilityEntities(spec) : []), [spec]);
  const entityPicks = useMemo(() => (gate && state && (state.type === 'entity' || state.type === 'partOf')
    ? entityOptions(gate, versions).map((e) => ({ value: e.name, ...(e.abstract ? { dim: true, badges: [{ label: t('idsStudio.picker.abstract'), tone: 'warn' as const }] } : {}) }))
    : []), [gate, versions, state, t]);
  if (!gate || !spec) return null;
  const label = section === 'applicability' ? t('idsStudio.spec.addApplicability') : t('idsStudio.spec.addRequirement');
  const submit = (next: DraftState) => {
    const draft = toDraft(next);
    if (!draft) return;
    const { ops, facetId } = addFacetOps(specId, section, draft, 'required');
    if (dispatch(ops, { label }).ok) { setState(null); select(facetId); }
  };
  const start = (type: FacetType) => {
    const next: DraftState = { type, name: '', pset: '', property: '', relation: 'IfcRelContainedInSpatialStructure' };
    // Classification and material facets need no field: add at once.
    if (type === 'classification' || type === 'material') submit(next);
    else setState(next);
  };
  return <div className="w-full space-y-1">
    <div className="flex items-center gap-1">
      <Plus className="h-3 w-3 text-muted-foreground" aria-hidden />
      <label htmlFor={`${specId}-${section}-add`} className="text-2xs text-muted-foreground">{label}</label>
      <select id={`${specId}-${section}-add`} className="h-7 rounded border border-input bg-background px-1 text-xs" value=""
        onChange={(event) => { if (event.target.value) start(event.target.value as FacetType); }}>
        <option value="">{t('idsStudio.spec.chooseFacet')}</option>
        {FACET_TYPES.map((type) => <option key={type} value={type}>{t(FACET_LABEL[type])}</option>)}
      </select>
    </div>
    {state && <form className="space-y-1.5 rounded border border-dashed border-border p-2" aria-label={t('idsStudio.spec.newFacet', { type: t(FACET_LABEL[state.type]) })}
      onSubmit={(event) => { event.preventDefault(); submit(state); }}>
      <p className="text-2xs font-medium">{t('idsStudio.spec.newFacet', { type: t(FACET_LABEL[state.type]) })}</p>
      {(state.type === 'entity' || state.type === 'partOf') && <NamePicker label={t('idsStudio.field.entity')} value={state.name} options={entityPicks}
        emptyText={t('idsStudio.picker.empty')} onPick={(name) => setState({ ...state, name })} />}
      {state.type === 'partOf' && <select aria-label={t('idsStudio.field.relation')} className="h-7 w-full rounded border border-input bg-background px-1 text-xs" value={state.relation}
        onChange={(event) => setState({ ...state, relation: event.target.value as PartOfRelation })}>
        {(['IfcRelAggregates', 'IfcRelAssignsToGroup', 'IfcRelContainedInSpatialStructure', 'IfcRelNests', 'IfcRelVoidsElement', 'IfcRelFillsElement'] as const)
          .map((r) => <option key={r} value={r}>{r}</option>)}
      </select>}
      {state.type === 'attribute' && <NamePicker label={t('idsStudio.field.attribute')} value={state.name} emptyText={t('idsStudio.picker.empty')}
        options={attributeOptions(gate, versions, entities).map((value) => ({ value }))} onPick={(name) => setState({ ...state, name })} />}
      {state.type === 'property' && <>
        <NamePicker label={t('idsStudio.field.propertySet')} value={state.pset} emptyText={t('idsStudio.picker.empty')}
          options={psetOptions(gate, versions, entities, entities.length === 0).map((p) => ({ value: p.name }))}
          onPick={(pset) => setState({ ...state, pset, property: '', dataType: undefined })} />
        <NamePicker label={t('idsStudio.field.property')} value={state.property} emptyText={t('idsStudio.picker.empty')}
          options={propertyOptions(gate, versions, state.pset).map((p) => ({ value: p.name, ...(p.dataType ? { detail: p.dataType } : {}) }))}
          onPick={(property) => setState({ ...state, property, dataType: propertyOptions(gate, versions, state.pset).find((p) => p.name === property)?.dataType })} />
      </>}
      <div className="flex gap-1">
        <Button type="submit" size="sm" className="h-7" disabled={!toDraft(state)}>{t('idsStudio.spec.addFacet')}</Button>
        <Button type="button" size="sm" variant="ghost" className="h-7" onClick={() => setState(null)}>{t('idsStudio.spec.cancel')}</Button>
      </div>
    </form>}
  </div>;
}

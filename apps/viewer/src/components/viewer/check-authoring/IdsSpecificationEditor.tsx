/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo } from 'react';
import { createTranslationService, type IDSFacet, type IDSRequirement, type IDSSpecification, type RequirementOptionality } from '@ifc-lite/ids';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { specificationCardinality, withSpecificationCardinality, type SpecificationCardinality } from '@/lib/check-authoring/ids-proposal';
import { TextField } from './DraftParts';

const SPEC_CARDINALITIES: SpecificationCardinality[] = ['required', 'optional', 'prohibited'];

function optionalities(facet: IDSFacet): RequirementOptionality[] {
  if (facet.type === 'entity') return ['required'];
  return facet.type === 'partOf' ? ['required', 'prohibited'] : ['required', 'optional', 'prohibited'];
}

/** The editable simple value of a requirement facet, when it has one. */
function simpleValue(facet: IDSFacet): string | null {
  return 'value' in facet && facet.value?.type === 'simpleValue' ? facet.value.value : null;
}

function withValue(requirement: IDSRequirement, value: string): IDSRequirement {
  const facet = requirement.facet;
  if (!('value' in facet)) return requirement;
  return { ...requirement, facet: { ...facet, value: { type: 'simpleValue', value } } };
}

const selectClass = 'h-7 rounded border border-input bg-background px-1';

/** Inline edits of one drafted specification; every edit re-runs the native serialisation and audit. */
export function IdsSpecificationEditor({ spec, index, disabled, onChange }: {
  spec: IDSSpecification; index: number; disabled: boolean; onChange: (spec: IDSSpecification) => void;
}) {
  const { t } = useTranslation();
  const locale = useViewerStore(s => s.idsLocale);
  const describe = useMemo(() => createTranslationService(locale), [locale]);
  const id = `ids-draft-spec-${index}`;
  const setRequirement = (at: number, requirement: IDSRequirement) =>
    onChange({ ...spec, requirements: spec.requirements.map((item, i) => i === at ? requirement : item) });
  return <li className="rounded border border-border p-2 space-y-1.5">
    <TextField id={`${id}-name`} label={t('checkAuthoring.specName')} value={spec.name} disabled={disabled} onChange={name => onChange({ ...spec, name })} />
    <div className="flex items-center gap-1.5">
      <label htmlFor={`${id}-cardinality`} className="text-2xs text-muted-foreground">{t('checkAuthoring.specCardinality')}</label>
      <select id={`${id}-cardinality`} className={selectClass} disabled={disabled} value={specificationCardinality(spec)}
        onChange={event => onChange(withSpecificationCardinality(spec, event.target.value as SpecificationCardinality))}>
        {SPEC_CARDINALITIES.map(value => <option key={value} value={value}>{t(`checkAuthoring.cardinality.${value}`)}</option>)}
      </select>
    </div>
    <div>
      <p className="text-2xs text-muted-foreground">{t('checkAuthoring.appliesTo')}</p>
      <ul className="pl-2">{spec.applicability.facets.map((facet, i) => <li key={i} className="break-words">{describe.describeFacet(facet, 'applicability')}</li>)}</ul>
    </div>
    {spec.requirements.length > 0 && <div className="space-y-1">
      <p className="text-2xs text-muted-foreground">{t('checkAuthoring.requires')}</p>
      <ul className="space-y-1">{spec.requirements.map((requirement, i) => {
        const value = simpleValue(requirement.facet);
        return <li key={i} className="pl-2 border-l border-border space-y-1">
          <p className="break-words">{describe.describeRequirement(requirement)}</p>
          {requirement.instructions && <p className="text-muted-foreground whitespace-pre-wrap break-words">{requirement.instructions}</p>}
          <div className="flex flex-wrap items-end gap-1.5">
            <div className="space-y-0.5">
              <label htmlFor={`${id}-req-${i}-cardinality`} className="block text-2xs text-muted-foreground">{t('checkAuthoring.requirementCardinality')}</label>
              <select id={`${id}-req-${i}-cardinality`} className={selectClass} disabled={disabled || requirement.facet.type === 'entity'} value={requirement.optionality}
                onChange={event => setRequirement(i, { ...requirement, optionality: event.target.value as RequirementOptionality })}>
                {optionalities(requirement.facet).map(option => <option key={option} value={option}>{t(`checkAuthoring.cardinality.${option}`)}</option>)}
              </select>
            </div>
            {value !== null && <div className="min-w-0 flex-1"><TextField id={`${id}-req-${i}-value`} label={t('checkAuthoring.requiredValue')} value={value}
              disabled={disabled} onChange={next => setRequirement(i, withValue(requirement, next))} /></div>}
          </div>
        </li>;
      })}</ul>
    </div>}
  </li>;
}

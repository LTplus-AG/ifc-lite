/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The flood check's verdict for the selected element, in the property panel:
 * the outcome (in its viewport colour), what it establishes and what it does
 * not, the screening caveat, and the `IfcLite_SurfaceRunoffExposure` property
 * set `@ifc-lite/flood-check` derives for it. The set is NOT in the model; the
 * group label says so, and the card renders read-only.
 */

import { PropertyValueType } from '@ifc-lite/data';
import type { FloodPropertySet, FloodPropertyType } from '@ifc-lite/flood-check';
import type { ProjectUnits } from '@ifc-lite/parser';
import { Droplets } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { localized, OUTCOME_LABEL_KEY, outcomeCss } from '@/lib/flood-check/flood-verdicts';
import type { PropertySet } from './encodingUtils';
import { InspectorGroupLabel } from './inspector-ui';
import { PropertySetCard } from './PropertySetCard';

const VALUE_TYPE: Record<FloodPropertyType, PropertyValueType> = {
  IfcLabel: PropertyValueType.Label,
  IfcText: PropertyValueType.Text,
  IfcIdentifier: PropertyValueType.Identifier,
  IfcInteger: PropertyValueType.Integer,
  IfcBoolean: PropertyValueType.Boolean,
  IfcLengthMeasure: PropertyValueType.Real,
};

/** A flood-check payload as the panel's property-set shape. */
export function floodPropertySet(set: FloodPropertySet): PropertySet {
  return {
    name: set.Name,
    properties: set.Properties.map((p) => ({ name: p.Name, value: p.NominalValue, type: VALUE_TYPE[p.Type], dataType: p.Type })),
  };
}

export function FloodExposureCard({ modelId, expressId, projectUnits, projectUnitsAvailable }: { modelId: string; expressId: number; projectUnits: ProjectUnits; projectUnitsAvailable: boolean }) {
  const { t, locale } = useTranslation();
  const data = useViewerStore((s) => (s.floodCheck?.modelId === modelId && s.floodCheck.status === 'done' ? s.floodCheck.data : null));
  const entry = data?.result.results.find((r) => r.candidate.expressId === expressId);
  const set = data?.elementSets.get(expressId);
  if (!entry || !set) return null;
  return (
    <div className="flex w-full flex-col overflow-hidden" data-testid="flood-exposure-card" data-outcome={entry.outcome}>
      <InspectorGroupLabel icon={<Droplets className="h-3 w-3 shrink-0" />}>{t('floodCheck.card.heading')}</InspectorGroupLabel>
      <div className="space-y-1 px-3 py-2">
        <p className="flex items-center gap-2 text-xs font-semibold">
          <span aria-hidden className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: outcomeCss(entry.outcome) }} />
          {t(OUTCOME_LABEL_KEY[entry.outcome])}
          {entry.hazardClass && <span className="font-normal text-muted-foreground">· {localized(entry.hazardClass.label, locale)}</span>}
        </p>
        <p className="text-xs text-foreground">{localized(entry.meaning, locale)}</p>
        <p className="text-2xs text-muted-foreground">{localized(entry.caveat, locale)}</p>
        <p className="text-2xs text-muted-foreground">{t('floodCheck.card.notInModel')}</p>
      </div>
      <PropertySetCard pset={floodPropertySet(set)} projectUnits={projectUnits} projectUnitsAvailable={projectUnitsAvailable} />
    </div>
  );
}

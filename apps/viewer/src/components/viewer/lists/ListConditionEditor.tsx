/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `listCondition` rule row (#6190): every Lists value predicate in the
 * shared Rules editor. The source picker chooses what is read (a zone set, an
 * exact spatial level, the model file, a Lists attribute, a property or
 * quantity, material, classification, a world coordinate); the fields after
 * it are that source's, stored exactly as the Lists engine reads them.
 *
 * A zone rule stores the zone SET's durable id and shows its current name; a
 * set that no longer exists stays selected and says so rather than silently
 * moving the rule to another set. Suggestions come from every loaded model
 * through `ListValueOptionsContext`, which the Lists builder provides.
 */

import { useContext, useMemo } from 'react';
import { Rule, type FilterRule, type ListConditionRule } from '@ifc-lite/rules';
import { ENTITY_ATTRIBUTES, isZoneVolumeMode, type ConditionOperator, type PropertyCondition } from '@ifc-lite/lists';
import { ComboInput } from '@/components/ui/combo-input';
import { useTranslation } from '@/i18n';
import { propValueKey } from '@/lib/search/filter-schema';
import { LIST_OPERATOR_LABEL_KEYS } from '@/lib/filter-operator-labels';
import {
  GEOMETRY_AXES, LIST_VALUE_SOURCES, SPATIAL_LEVELS, ZONE_MODES, ZONE_MODE_BREAKDOWN_LABEL, ZONE_MODE_NAME,
  ZONE_MODE_STRADDLES, ZONE_MODE_VOLUME_LABEL, defaultConditionFor, operatorsFor, type ConditionSource,
} from '@/lib/lists/list-condition-fields';
import { InheritSelect } from '../InheritSelect';
import { ListValueOptionsContext } from './use-list-value-options';

const NO_OPTIONS: readonly string[] = [];
const SELECT_CLASS = 'h-7 rounded border border-zinc-300 bg-transparent px-1 text-xs dark:border-zinc-700';

/** Rebuild through the constructor so an absent optional field is absent, not `undefined`. */
function withCondition(condition: PropertyCondition): ListConditionRule {
  const { psetName, inherit, ...rest } = condition;
  return Rule.listCondition({ ...rest, ...(psetName !== undefined ? { psetName } : {}), ...(inherit ? { inherit } : {}) });
}

export function ListConditionEditor({ rule, onChange }: { rule: ListConditionRule; onChange: (next: FilterRule) => void }) {
  const { t } = useTranslation();
  const options = useContext(ListValueOptionsContext);
  const zoneSets = options?.zoneSets ?? [];
  const set = (patch: Partial<PropertyCondition>) => onChange(withCondition({ ...rule, ...patch }));
  /** A new mode can read a different kind of value (a zone volume is a number), so its operators change too. */
  const setMode = (propertyName: string, value: PropertyCondition['value'] = rule.value) => {
    const allowed = operatorsFor(rule.source, propertyName);
    set({ propertyName, value, operator: allowed.includes(rule.operator) ? rule.operator : allowed[0]! });
  };

  const sourceLabels: Record<ConditionSource, string> = {
    zone: t('lists.builder.source.zone'), spatial: t('lists.builder.source.spatial'),
    model: t('lists.builder.source.model'), attribute: t('lists.builder.source.attribute'),
    property: t('lists.builder.source.property'), quantity: t('lists.builder.source.quantity'),
    material: t('lists.builder.source.material'), classification: t('lists.builder.source.classification'),
    geometry: t('lists.builder.source.geometry'),
  };
  const levelLabels: Record<string, string> = {
    Container: t('lists.builder.spatial.container'), Storey: t('lists.builder.spatial.storey'),
    Building: t('lists.builder.spatial.building'), Site: t('lists.builder.spatial.site'),
    Project: t('lists.builder.spatial.project'),
  };
  const zoneModeLabels: Record<string, string> = {
    [ZONE_MODE_NAME]: t('lists.builder.zoneOption'), [ZONE_MODE_STRADDLES]: t('lists.builder.straddlesOption'),
    [ZONE_MODE_VOLUME_LABEL]: t('lists.builder.zoneVolumeOption'), [ZONE_MODE_BREAKDOWN_LABEL]: t('lists.builder.zoneBreakdownOption'),
  };

  const changeSource = (source: ConditionSource) => {
    const next = defaultConditionFor(source, zoneSets);
    // Keep the comparison when it still means something for the new source.
    onChange(withCondition(operatorsFor(source, next.propertyName).includes(rule.operator) ? { ...next, operator: rule.operator } : next));
  };

  const isSet = rule.source === 'property' || rule.source === 'quantity';
  const zoneSet = rule.source === 'zone' ? zoneSets.find((zs) => zs.id === rule.psetName) : undefined;
  const setNames = useMemo(() => {
    const discovered = options?.discovered;
    if (!discovered || !isSet) return NO_OPTIONS;
    return [...(rule.source === 'property' ? discovered.properties : discovered.quantities).keys()].sort();
  }, [options?.discovered, isSet, rule.source]);
  const memberNames = useMemo(() => {
    const discovered = options?.discovered;
    if (!discovered || !isSet) return NO_OPTIONS;
    return (rule.source === 'property' ? discovered.properties : discovered.quantities).get(rule.psetName ?? '') ?? NO_OPTIONS;
  }, [options?.discovered, isSet, rule.source, rule.psetName]);

  const mode = rule.propertyName;
  const volumeMode = isZoneVolumeMode(mode) || mode.toLowerCase() === ZONE_MODE_BREAKDOWN_LABEL.toLowerCase();
  const valueOptions = useMemo<readonly string[]>(() => {
    switch (rule.source) {
      case 'property': return options?.values?.propertyValues.get(propValueKey(rule.psetName ?? '', rule.propertyName)) ?? NO_OPTIONS;
      case 'material': return options?.values?.materials ?? NO_OPTIONS;
      case 'classification': return options?.values?.classifications ?? NO_OPTIONS;
      case 'spatial': return options?.spatialNames[rule.propertyName] ?? options?.spatialNames.Storey ?? NO_OPTIONS;
      case 'model': return options?.modelNames ?? NO_OPTIONS;
      case 'zone':
        if (mode === ZONE_MODE_STRADDLES) return ['true', 'false'];
        // A volume compares against a number; zone names would suggest a comparison that never matches.
        return volumeMode ? NO_OPTIONS : zoneSet?.zones.map((z) => z.name) ?? NO_OPTIONS;
      default: return NO_OPTIONS;
    }
  }, [rule.source, rule.psetName, rule.propertyName, mode, volumeMode, options, zoneSet]);

  const placeholder = rule.source === 'spatial' ? t('lists.builder.valuePlaceholder.spatial', { level: levelLabels[rule.propertyName] ?? rule.propertyName })
    : rule.source === 'model' ? t('lists.builder.valuePlaceholder.model')
      : rule.source === 'material' ? t('lists.builder.valuePlaceholder.material')
        : rule.source === 'classification' ? t('lists.builder.valuePlaceholder.classification')
          : rule.source !== 'zone' ? t('lists.builder.valuePlaceholder.value')
            : mode === ZONE_MODE_STRADDLES ? t('lists.builder.valuePlaceholder.boolean')
              : isZoneVolumeMode(mode) ? t('lists.builder.valuePlaceholder.volume')
                : volumeMode ? t('lists.builder.valuePlaceholder.zoneBreakdown') : t('lists.builder.valuePlaceholder.zoneName');

  const ops: ConditionOperator[] = operatorsFor(rule.source, rule.propertyName);
  if (!ops.includes(rule.operator)) ops.push(rule.operator);
  const levels: readonly string[] = SPATIAL_LEVELS.includes(rule.propertyName as (typeof SPATIAL_LEVELS)[number])
    ? SPATIAL_LEVELS : [...SPATIAL_LEVELS, rule.propertyName];
  const modes: readonly string[] = ZONE_MODES.includes(mode as (typeof ZONE_MODES)[number]) ? ZONE_MODES : [...ZONE_MODES, mode];
  const attributes: readonly string[] = (ENTITY_ATTRIBUTES as readonly string[]).includes(rule.propertyName)
    ? ENTITY_ATTRIBUTES : [...ENTITY_ATTRIBUTES, rule.propertyName];

  return (
    <>
      <select value={rule.source} onChange={(e) => changeSource(e.target.value as ConditionSource)}
        aria-label={t('lists.builder.listValueSourceAriaLabel')} className={SELECT_CLASS}>
        {LIST_VALUE_SOURCES.map((source) => <option key={source} value={source}>{sourceLabels[source]}</option>)}
      </select>

      {rule.source === 'zone' && (
        <>
          <select value={rule.psetName ?? ''} onChange={(e) => set({ psetName: e.target.value, value: '' })}
            aria-label={t('lists.builder.zoneSetAriaLabel')} className={SELECT_CLASS}>
            {!rule.psetName && (
              <option value="">{zoneSets.length > 0 ? t('lists.builder.chooseZoneSet') : t('lists.builder.noZoneSets')}</option>
            )}
            {rule.psetName && !zoneSet && <option value={rule.psetName}>{t('lists.builder.missingZoneSet', { id: rule.psetName })}</option>}
            {zoneSets.map((zs) => <option key={zs.id} value={zs.id}>{zs.name}</option>)}
          </select>
          <select value={mode} onChange={(e) => setMode(e.target.value, '')}
            aria-label={t('lists.builder.zoneDisplayModeAriaLabel')} className={SELECT_CLASS}>
            {modes.map((m) => <option key={m} value={m}>{zoneModeLabels[m] ?? m}</option>)}
          </select>
        </>
      )}

      {rule.source === 'spatial' && (
        <select value={rule.propertyName} onChange={(e) => setMode(e.target.value, '')}
          aria-label={t('lists.builder.spatialLevelAriaLabel')} className={SELECT_CLASS}>
          {levels.map((level) => <option key={level} value={level}>{levelLabels[level] ?? level}</option>)}
        </select>
      )}

      {rule.source === 'attribute' && (
        <select value={rule.propertyName} onChange={(e) => setMode(e.target.value)}
          aria-label={t('lists.builder.attributeAriaLabel')} className={SELECT_CLASS}>
          {attributes.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      )}

      {rule.source === 'geometry' && (
        <select value={rule.propertyName} onChange={(e) => setMode(e.target.value)}
          aria-label={t('lists.builder.axisAriaLabel')} className={SELECT_CLASS}>
          {(GEOMETRY_AXES as readonly string[]).concat((GEOMETRY_AXES as readonly string[]).includes(rule.propertyName) ? [] : [rule.propertyName])
            .map((axis) => <option key={axis} value={axis}>{axis}</option>)}
        </select>
      )}

      {isSet && (
        <>
          <ComboInput value={rule.psetName ?? ''} options={setNames} className="h-7 w-32 text-xs font-mono"
            placeholder={rule.source === 'quantity' ? t('lists.builder.qtoPlaceholder') : t('lists.builder.psetPlaceholder')}
            onChange={(psetName) => set({ psetName })} />
          <ComboInput value={rule.propertyName} options={memberNames} className="h-7 w-28 text-xs font-mono"
            placeholder={t('lists.builder.namePropertyPlaceholder')} onChange={(propertyName) => set({ propertyName })} />
          <InheritSelect value={rule.inherit} offered={rule.inherit === 'type' ? ['type', 'aggregation'] : ['aggregation']} className={SELECT_CLASS}
            onChange={(inherit) => set({ inherit })} />
        </>
      )}

      <select value={rule.operator} onChange={(e) => set({ operator: e.target.value as ConditionOperator })}
        aria-label={t('lists.builder.operatorAriaLabel')} className={SELECT_CLASS}>
        {ops.map((op) => <option key={op} value={op}>{t(LIST_OPERATOR_LABEL_KEYS[op])}</option>)}
      </select>

      {rule.operator !== 'exists' && (
        <ComboInput value={String(rule.value)} options={valueOptions} placeholder={placeholder}
          className="h-7 w-44 text-xs font-mono" onChange={(value) => set({ value })} />
      )}
    </>
  );
}

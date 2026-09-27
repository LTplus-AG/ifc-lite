/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { Plus, Trash2, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ComboInput } from '@/components/ui/combo-input';
import { InheritSelect } from '../InheritSelect';
import { useTranslation } from '@/i18n/useTranslation';
import { propValueKey } from '@/lib/search/filter-schema';
import { LIST_OPERATOR_LABEL_KEYS } from '@/lib/filter-operator-labels';
import { ENTITY_ATTRIBUTES, isZoneVolumeMode, migrateLegacyListConditions, type ConditionOperator, type DiscoveredColumns, type ListDataProvider, type PropertyCondition, type UnreadableListCondition } from '@ifc-lite/lists';
import type { FilterRule } from '@ifc-lite/rules';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { ZoneSet } from '@/lib/zones';
import type { ListConditionValues, StoreWithView } from './list-builder-discovery';
import { describeUneditable, isEditableCondition, operatorsFor, type ConditionSource } from '@/lib/lists/compatibility-condition';
import { useLegacyListFilterOptions } from './use-legacy-list-filter-options';

const NO_OPTIONS: readonly string[] = [];
const SPATIAL_LEVELS = ['Container', 'Storey', 'Building', 'Site', 'Project'] as const;
const ZONE_MODE_VOLUME_LABEL = 'Volume (mesh)';
const ZONE_MODE_BREAKDOWN_LABEL = 'Volume breakdown (mesh)';

type CompatibilityPreset = 'zone' | 'spatial' | 'quantity' | 'material' | 'model' | 'attribute' | 'property';
const COMPATIBILITY_PRESETS: readonly CompatibilityPreset[] = [
  'zone', 'spatial', 'quantity', 'material', 'model', 'attribute', 'property',
];

function conditionForPreset(preset: CompatibilityPreset, zoneSets: ZoneSet[]): PropertyCondition {
  switch (preset) {
    case 'spatial': return { ...defaultConditionFor('spatial'), propertyName: 'Building' };
    case 'quantity': return { ...defaultConditionFor('quantity'), operator: 'exists' };
    case 'material': return { ...defaultConditionFor('material'), operator: 'exists' };
    case 'model': return { ...defaultConditionFor('model'), operator: 'contains' };
    case 'attribute': return { ...defaultConditionFor('attribute'), propertyName: 'GlobalId' };
    case 'property': return { ...defaultConditionFor('property'), inherit: 'aggregation' };
    case 'zone': return defaultConditionFor('zone', zoneSets);
  }
}

/** `zoneSets` supplies the default zone-SET id for a fresh `zone` condition
 *  (the first defined set, so switching the source dropdown to Zone lands
 *  on something usable rather than an empty set-picker). */
function defaultConditionFor(source: ConditionSource, zoneSets: ZoneSet[] = []): PropertyCondition {
  switch (source) {
    case 'property':
      return { source, psetName: '', propertyName: '', operator: 'equals', value: '' };
    case 'quantity':
      return { source, psetName: '', propertyName: '', operator: 'gt', value: '' };
    case 'material':
      return { source, propertyName: 'Material', operator: 'contains', value: '' };
    case 'classification':
      return { source, propertyName: 'Classification', operator: 'contains', value: '' };
    case 'spatial':
      return { source, propertyName: 'Storey', operator: 'equals', value: '' };
    case 'model':
      return { source, propertyName: 'Model', operator: 'equals', value: '' };
    case 'zone':
      return { source, psetName: zoneSets[0]?.id ?? '', propertyName: 'Zone', operator: 'equals', value: '' };
    case 'attribute':
    default:
      return { source: 'attribute', propertyName: 'Name', operator: 'contains', value: '' };
  }
}

const SELECT_CLASS =
  'h-7 rounded-md border border-border bg-background px-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring';

interface LegacyListFiltersProps {
  rows: UnreadableListCondition[];
  onChange: Dispatch<SetStateAction<UnreadableListCondition[]>>;
  onPromote: (index: number, rule: FilterRule) => boolean;
  discovered: DiscoveredColumns;
  stores: readonly IfcDataStore[];
  storeViews: readonly StoreWithView[];
  providers: readonly ListDataProvider[];
  mutationVersion: number;
  zoneSets: ZoneSet[];
}

// TODO(remove-by: #6190 ships lossless Rules equivalents, owner: viewer charter)
/** Provider-only predicates preserve authoring modes that Rules cannot yet
 * express, while Rules groups remain the primary editor. These predicates
 * narrow every group through the existing List candidate pass. */
export function LegacyListFilters({ rows, onChange, onPromote, discovered, stores, storeViews, providers, mutationVersion, zoneSets }: LegacyListFiltersProps) {
  const { t } = useTranslation();
  const { values, spatialNames, modelNames } = useLegacyListFilterOptions(rows, stores, storeViews, providers, mutationVersion);
  const editable = rows.flatMap((row, index) => isEditableCondition(row) ? [{ condition: row.condition, index }] : []);
  const invalid = rows.flatMap((row, index) => isEditableCondition(row) ? [] : [{ row, index }]);
  return (
    <div className="mt-3 space-y-2">
      <p className="text-xs font-medium">{t('lists.builder.compatibilityFilters')}</p>
      <p className="text-xs text-muted-foreground">{t('lists.builder.compatibilityFiltersHint')}</p>
      {editable.length > 0 && <p role="status" className="text-xs text-amber-600 dark:text-amber-400">{t('lists.builder.compatibilityActiveWarning')}</p>}
      <ConditionsBody
        conditions={editable} discovered={discovered} values={values}
        spatialNames={spatialNames} modelNames={modelNames} zoneSets={zoneSets}
        onAdd={(condition) => onChange((current) => [...current, { condition, reason: 'unsupported-source' }])}
        onUpdate={(index, condition) => {
          const rule = migrateLegacyListConditions([condition]).groups[0]?.rules[0];
          if (rule && onPromote(index, rule)) return;
          onChange((current) => current.map((row, i) => i === index ? { ...row, condition } : row));
        }}
        onRemove={(index) => onChange((current) => current.filter((_, i) => i !== index))}
      />
      {invalid.length > 0 && (
        <div role="alert" className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
          <p className="mb-2 flex items-center gap-1.5 font-medium"><AlertTriangle className="h-3.5 w-3.5" aria-hidden />{t('lists.builder.unreadableWarning')}</p>
          {invalid.map(({ row, index }) => (
            <div key={index} className="flex items-center justify-between gap-2">
              <span>{describeUneditable(row, t('lists.builder.malformedCondition'))}</span>
              <Button type="button" variant="ghost" size="sm" onClick={() => onChange((current) => current.filter((_, i) => i !== index))}>
                {t('lists.builder.removeUnreadable')}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ConditionsBody({
  conditions,
  discovered,
  values,
  spatialNames,
  modelNames,
  zoneSets,
  onAdd,
  onUpdate,
  onRemove,
}: {
  conditions: { condition: PropertyCondition; index: number }[];
  discovered: DiscoveredColumns;
  values: ListConditionValues | null;
  spatialNames: Record<string, string[]>;
  modelNames: string[];
  zoneSets: ZoneSet[];
  onAdd: (condition: PropertyCondition) => void;
  onUpdate: (idx: number, condition: PropertyCondition) => void;
  onRemove: (idx: number) => void;
}) {
  const [preset, setPreset] = useState<CompatibilityPreset>('zone');
  const { t } = useTranslation(); return (
    <div className="space-y-1.5">
      {conditions.map(({ condition, index }) => (
        <ConditionRow
          key={index}
          condition={condition}
          discovered={discovered}
          values={values}
          spatialNames={spatialNames}
          modelNames={modelNames}
          zoneSets={zoneSets}
          onChange={(next) => onUpdate(index, next)}
          onRemove={() => onRemove(index)}
        />
      ))}
      <div className="flex flex-wrap items-center gap-1.5">
      <select
        value={preset}
        onChange={(event) => setPreset(event.target.value as CompatibilityPreset)}
        className={SELECT_CLASS}
        aria-label={t('lists.builder.compatibilityPresetAriaLabel')}
      >
        {COMPATIBILITY_PRESETS.map((kind) => <option key={kind} value={kind}>{t(`lists.builder.compatibilityPreset.${kind}`)}</option>)}
      </select>
      <button
        type="button"
        onClick={() => onAdd(conditionForPreset(preset, zoneSets))}
        className="flex items-center gap-1 rounded-md border border-dashed border-border px-2 py-1 text-xs text-muted-foreground hover:border-primary/50 hover:text-foreground"
      >
        <Plus className="h-3.5 w-3.5" /> {t('lists.builder.addFilter')}
      </button>
      </div>
    </div>
  );
}

function ConditionRow({
  condition,
  discovered,
  values,
  spatialNames,
  modelNames,
  zoneSets,
  onChange,
  onRemove,
}: {
  condition: PropertyCondition;
  discovered: DiscoveredColumns;
  values: ListConditionValues | null;
  spatialNames: Record<string, string[]>;
  modelNames: string[];
  zoneSets: ZoneSet[];
  onChange: (next: PropertyCondition) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const sourceLabels: Partial<Record<ConditionSource, string>> = {
    attribute: t('lists.builder.source.attribute'), property: t('lists.builder.source.property'),
    quantity: t('lists.builder.source.quantity'), material: t('lists.builder.source.material'),
    classification: t('lists.builder.source.classification'), spatial: t('lists.builder.source.spatial'),
    model: t('lists.builder.source.model'), zone: t('lists.builder.source.zone'),
  };
  const spatialLevelLabels: Record<string, string> = {
    Container: t('lists.builder.spatial.container'), Storey: t('lists.builder.spatial.storey'),
    Building: t('lists.builder.spatial.building'), Site: t('lists.builder.spatial.site'),
    Project: t('lists.builder.spatial.project'),
  };
  const ops = operatorsFor(condition.source);
  const showValue = condition.operator !== 'exists';
  const isProperty = condition.source === 'property';
  const isQuantity = condition.source === 'quantity';
  const isSpatial = condition.source === 'spatial';
  const isZone = condition.source === 'zone';
  const showSetFields = isProperty || isQuantity;

  const setNameOptions = useMemo<string[]>(() => {
    if (isProperty) return Array.from(discovered.properties.keys()).sort();
    if (isQuantity) return Array.from(discovered.quantities.keys()).sort();
    return [];
  }, [discovered, isProperty, isQuantity]);

  const propNameOptions = useMemo<string[]>(() => {
    const set = condition.psetName ?? '';
    if (isProperty) return [...(discovered.properties.get(set) ?? [])];
    if (isQuantity) return [...(discovered.quantities.get(set) ?? [])];
    return [];
  }, [discovered, condition.psetName, isProperty, isQuantity]);

  const zoneNameOptions = useMemo<string[]>(() => {
    if (!isZone) return [];
    const set = zoneSets.find((zs) => zs.id === condition.psetName);
    return set ? set.zones.map((z) => z.name) : [];
  }, [isZone, zoneSets, condition.psetName]);

  const valueOptions = useMemo<readonly string[]>(() => {
    switch (condition.source) {
      case 'property':
        return values?.propertyValues.get(propValueKey(condition.psetName ?? '', condition.propertyName)) ?? NO_OPTIONS;
      case 'material': return values?.materials ?? NO_OPTIONS;
      case 'classification': return values?.classifications ?? NO_OPTIONS;
      case 'spatial': return spatialNames[condition.propertyName] ?? spatialNames.Storey ?? NO_OPTIONS;
      case 'model': return modelNames;
      case 'zone':
        if (condition.propertyName === 'Straddles') return ['true', 'false'];
        // A volume mode compares against a NUMBER, so offering zone names as
        // completions would suggest a comparison that can never match.
        if (isZoneVolumeMode(condition.propertyName) || condition.propertyName === ZONE_MODE_BREAKDOWN_LABEL) return [];
        return zoneNameOptions;
      default: return NO_OPTIONS;
    }
  }, [condition.source, condition.psetName, condition.propertyName, values, spatialNames, modelNames, zoneNameOptions]);

  const valuePlaceholder =
    condition.source === 'spatial' ? t('lists.builder.valuePlaceholder.spatial', { level: spatialLevelLabels[condition.propertyName || 'Storey'] ?? condition.propertyName })
      : condition.source === 'model' ? t('lists.builder.valuePlaceholder.model')
        : condition.source === 'material' ? t('lists.builder.valuePlaceholder.material')
          : condition.source === 'classification' ? t('lists.builder.valuePlaceholder.classification')
            : condition.source === 'zone' ? (
              condition.propertyName === 'Straddles' ? t('lists.builder.valuePlaceholder.boolean')
                : isZoneVolumeMode(condition.propertyName) ? t('lists.builder.valuePlaceholder.volume')
                  : condition.propertyName === ZONE_MODE_BREAKDOWN_LABEL ? t('lists.builder.valuePlaceholder.zoneBreakdown')
                    : t('lists.builder.valuePlaceholder.zoneName')
            )
              : t('lists.builder.valuePlaceholder.value');

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-border/60 bg-card px-2 py-1.5 text-xs">
      <span className="min-w-16 font-medium">{sourceLabels[condition.source] ?? condition.source}</span>

      {condition.source === 'attribute' && (
        <select
          value={condition.propertyName}
          onChange={(e) => onChange({ ...condition, propertyName: e.target.value })}
          className={SELECT_CLASS}
          aria-label={t('lists.builder.attributeAriaLabel')}
        >
          {ENTITY_ATTRIBUTES.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
      )}

      {isSpatial && (
        <select
          value={condition.propertyName || 'Storey'}
          onChange={(e) => onChange({ ...condition, propertyName: e.target.value, value: '' })}
          className={SELECT_CLASS}
          aria-label={t('lists.builder.spatialLevelAriaLabel')}
        >
          {SPATIAL_LEVELS.map((level) => (
            <option key={level} value={level}>{spatialLevelLabels[level] ?? level}</option>
          ))}
        </select>
      )}

      {isZone && (
        <>
          <select
            value={condition.psetName ?? ''}
            onChange={(e) => onChange({ ...condition, psetName: e.target.value, value: '' })}
            className={SELECT_CLASS}
            aria-label={t('lists.builder.zoneSetAriaLabel')}
          >
            {zoneSets.length === 0 && <option value="">{t('lists.builder.noZoneSets')}</option>}
            {zoneSets.map((zs) => (
              <option key={zs.id} value={zs.id}>{zs.name}</option>
            ))}
          </select>
          <select
            value={condition.propertyName || 'Zone'}
            onChange={(e) => onChange({ ...condition, propertyName: e.target.value, value: '' })}
            className={SELECT_CLASS}
            aria-label={t('lists.builder.zoneDisplayModeAriaLabel')}
          >
            <option value="Zone">{t('lists.builder.zoneOption')}</option>
            <option value="Straddles">{t('lists.builder.straddlesOption')}</option>
            <option value={ZONE_MODE_VOLUME_LABEL}>{t('lists.builder.zoneVolumeOption')}</option>
            <option value={ZONE_MODE_BREAKDOWN_LABEL}>{t('lists.builder.zoneBreakdownOption')}</option>
          </select>
        </>
      )}

      {showSetFields && (
        <>
          <ComboInput
            value={condition.psetName ?? ''}
            options={setNameOptions}
            placeholder={isQuantity ? t('lists.builder.qtoPlaceholder') : t('lists.builder.psetPlaceholder')}
            className="h-7 w-32 text-xs"
            onChange={(v) => onChange({ ...condition, psetName: v })}
          />
          <ComboInput
            value={condition.propertyName}
            options={propNameOptions}
            placeholder={t('lists.builder.namePropertyPlaceholder')}
            className="h-7 w-28 text-xs"
            onChange={(v) => onChange({ ...condition, propertyName: v })}
          />
          <InheritSelect value={condition.inherit} offered={['aggregation']} onChange={(inherit) => onChange({ ...condition, inherit })} className={SELECT_CLASS} />
        </>
      )}

      <select
        value={condition.operator}
        onChange={(e) => onChange({ ...condition, operator: e.target.value as ConditionOperator })}
        className={SELECT_CLASS}
        aria-label={t('lists.builder.operatorAriaLabel')}
      >
        {ops.map((op) => (
          <option key={op} value={op}>{t(LIST_OPERATOR_LABEL_KEYS[op])}</option>
        ))}
      </select>

      {showValue && (
        <ComboInput
          value={String(condition.value ?? '')}
          options={valueOptions}
          placeholder={valuePlaceholder}
          className="h-7 w-44 text-xs"
          onChange={(v) => onChange({ ...condition, value: v })}
        />
      )}

      <button
        type="button"
        onClick={onRemove}
        aria-label={t('lists.builder.removeFilterAriaLabel')}
        className="ml-auto shrink-0 text-muted-foreground hover:text-destructive"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

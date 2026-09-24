/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `classification`, `group` and `modelFact` chip editors. The first two
 * are "belongs to something" rules with an optional scope (a classification system, a group
 * class) and the presence-or-name op set. Split out of
 * `SearchModal.filter.editors.tsx` for size.
 */

import { ComboInput } from '@/components/ui/combo-input';
import { useTranslation } from '@/i18n';
import { MODEL_FACTS, Rule, type FilterRule, type ModelFact } from '@ifc-lite/rules';
import type { FilterValueSchema } from '@/lib/search/filter-schema';
import { CLASSIFICATION_OPS, OpDropdown, VALUE_OPS } from './SearchModal.filter.editors.shared';

const NO_OPTIONS: readonly string[] = [];

/** `IfcGroup` and the subclasses a rule most often scopes to (#5226). */
const GROUP_CLASS_OPTIONS: readonly string[] = [
  'IfcSystem', 'IfcDistributionSystem', 'IfcBuildingSystem', 'IfcZone', 'IfcGroup',
];

export function ClassificationEditor({
  rule,
  valueSchema,
  onChange,
}: {
  rule: Extract<FilterRule, { kind: 'classification' }>;
  valueSchema: FilterValueSchema | null;
  onChange: (next: FilterRule) => void;
}) {
  const { t } = useTranslation();
  const valueless = rule.op === 'isSet' || rule.op === 'isNotSet';
  return (
    <>
      <ComboInput
        placeholder={t('searchModal.filterEditors.classificationSystemPlaceholder')}
        value={rule.system ?? ''}
        options={valueSchema?.classificationSystems ?? NO_OPTIONS}
        className="h-7 w-40 text-xs font-mono"
        aria-label={t('searchModal.filterEditors.classificationSystemAriaLabel')}
        onChange={(v) => onChange(Rule.classification(v, rule.op, rule.value))}
      />
      <OpDropdown
        ops={CLASSIFICATION_OPS}
        value={rule.op}
        onChange={(next) => onChange(Rule.classification(rule.system ?? '', next, rule.value))}
      />
      {!valueless && (
        <ComboInput
          placeholder={t('searchModal.filterEditors.classificationValuePlaceholder')}
          value={rule.value}
          options={valueSchema?.classifications ?? NO_OPTIONS}
          className="h-7 w-44 text-xs font-mono"
          onChange={(v) => onChange(Rule.classification(rule.system ?? '', rule.op, v))}
        />
      )}
    </>
  );
}

/** `group` (#5226): optional group class, then presence or a group-Name op. */
export function GroupEditor({
  rule,
  onChange,
}: {
  rule: Extract<FilterRule, { kind: 'group' }>;
  onChange: (next: FilterRule) => void;
}) {
  const { t } = useTranslation();
  const valueless = rule.op === 'isSet' || rule.op === 'isNotSet';
  return (
    <>
      <ComboInput
        placeholder={t('searchModal.filterEditors.groupClassPlaceholder')}
        value={rule.groupClass ?? ''}
        options={GROUP_CLASS_OPTIONS}
        className="h-7 w-40 text-xs font-mono"
        aria-label={t('searchModal.filterEditors.groupClassAriaLabel')}
        onChange={(v) => onChange(Rule.group(rule.op, rule.value, v || undefined, rule.valueKind))}
      />
      <OpDropdown
        ops={CLASSIFICATION_OPS}
        value={rule.op}
        onChange={(next) => onChange(Rule.group(next, rule.value, rule.groupClass, rule.valueKind))}
      />
      {!valueless && (
        <ComboInput
          placeholder={t('searchModal.filterEditors.groupNamePlaceholder')}
          value={rule.value}
          options={NO_OPTIONS}
          className="h-7 w-44 text-xs font-mono"
          onChange={(v) => onChange(Rule.group(rule.op, v, rule.groupClass, rule.valueKind))}
        />
      )}
    </>
  );
}

/** `modelFact` (#5442): which fact of the element's model, then any value op. */
export function ModelFactEditor({
  rule,
  onChange,
}: {
  rule: Extract<FilterRule, { kind: 'modelFact' }>;
  onChange: (next: FilterRule) => void;
}) {
  const { t } = useTranslation();
  const valueless = rule.op === 'isSet' || rule.op === 'isNotSet';
  return (
    <>
      <select
        value={rule.fact}
        onChange={(e) => onChange({ ...rule, fact: e.target.value as ModelFact })}
        aria-label={t('searchModal.filterEditors.modelFactAriaLabel')}
        className="h-7 rounded border border-zinc-300 bg-transparent px-1 text-xs font-mono dark:border-zinc-700"
      >
        {MODEL_FACTS.map((fact) => <option key={fact} value={fact}>{fact}</option>)}
      </select>
      <OpDropdown ops={VALUE_OPS} value={rule.op} onChange={(next) => onChange({ ...rule, op: next })} />
      {!valueless && (
        <ComboInput
          placeholder={t('searchModal.filterEditors.valuePlaceholder')}
          value={rule.value}
          options={NO_OPTIONS}
          className="h-7 w-44 text-xs font-mono"
          onChange={(value) => onChange({ ...rule, value, valueKind: undefined })}
        />
      )}
    </>
  );
}

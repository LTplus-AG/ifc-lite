/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `RuleCard` — one `InformationRule`'s editor (#5138 plan §6): name /
 * description / severity, `applicability` (`RuleBlockEditor`, every
 * `FilterRule` kind except `elevation` — `rule-set-io-requirement.ts`
 * rejects it unconditionally), the requirement-kind segmented control
 * (`RequirementEditor`), cardinality, and Case sensitive / Tolerance under
 * an "advanced" disclosure.
 */

import { useState } from 'react';
import { ChevronDown, Trash2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import type { FilterRule } from '@ifc-lite/rules';
import type { InformationRule } from '@ifc-lite/rules';
import { RuleBlockEditor } from './RuleBlockEditor';
import { RequirementEditor } from './RuleSetEditor.requirementEditor';
import type { FilterGroupEditorModel } from '../FilterGroupEditor';
import { RULE_KIND_LABEL } from '../filter-rule-labels';
import { useTranslation } from '@/i18n';

/** Every `FilterRule` kind an applicability block may use — everything
 *  except `elevation` (`rule-set-io-requirement.ts`'s `validateBlockRules`
 *  rejects it unconditionally: "no aggregate meaning", plan §3). */
const APPLICABILITY_KINDS: ReadonlySet<FilterRule['kind']> = new Set(
  (Object.keys(RULE_KIND_LABEL) as FilterRule['kind'][]).filter((k) => k !== 'elevation'),
);

export interface RuleCardProps {
  rule: InformationRule;
  onChange: (next: InformationRule) => void;
  onRemove: () => void;
  models: ReadonlyArray<FilterGroupEditorModel>;
  schemaVersion?: string;
}

export function RuleCard({ rule, onChange, onRemove, models, schemaVersion }: RuleCardProps) {
  const { t } = useTranslation();
  const [advancedOpen, setAdvancedOpen] = useState(false);

  return (
    <div className="flex flex-col gap-3 rounded border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="flex items-start gap-2">
        <div className="flex flex-1 flex-col gap-1.5">
          <Input
            value={rule.name}
            onChange={(e) => onChange({ ...rule, name: e.target.value })}
            placeholder={t('validationEditor.ruleCard.namePlaceholder')}
            aria-label={t('validationEditor.ruleCard.nameAriaLabel')}
            className="h-8 text-sm font-medium"
          />
          <Input
            value={rule.description ?? ''}
            onChange={(e) => onChange({ ...rule, description: e.target.value || undefined })}
            placeholder={t('validationEditor.ruleCard.descriptionPlaceholder')}
            aria-label={t('validationEditor.ruleCard.descriptionAriaLabel')}
            className="h-7 text-xs"
          />
        </div>
        <SeverityToggle
          value={rule.severity ?? 'error'}
          onChange={(severity) => onChange({ ...rule, severity: severity === 'error' ? undefined : severity })}
        />
        <button
          type="button"
          onClick={onRemove}
          aria-label={t('validationEditor.ruleCard.removeAriaLabel', { name: rule.name })}
          className="rounded p-1 text-muted-foreground hover:bg-zinc-100 hover:text-destructive dark:hover:bg-zinc-800"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>

      <section className="flex flex-col gap-1.5">
        <h4 className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t('validationEditor.ruleCard.applicability')}
        </h4>
        <RuleBlockEditor
          block={rule.applicability}
          onChange={(applicability) => onChange({ ...rule, applicability })}
          allowedKinds={APPLICABILITY_KINDS}
          models={models}
          schemaVersion={schemaVersion}
        />
      </section>

      <section className="flex flex-col gap-1.5">
        <h4 className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t('validationEditor.ruleCard.requirement')}
        </h4>
        <RequirementEditor
          requirement={rule.requirement}
          onChange={(requirement) => onChange({ ...rule, requirement })}
          models={models}
          schemaVersion={schemaVersion}
        />
      </section>

      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-1 text-2xs font-medium text-muted-foreground hover:text-foreground"
          >
            <ChevronDown className={`h-3 w-3 transition-transform ${advancedOpen ? 'rotate-180' : ''}`} />
            {t('validationEditor.ruleCard.advanced')}
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col gap-2 pt-2">
          <label className="flex items-center gap-2 text-xs">
            <Switch
              checked={rule.caseSensitive ?? true}
              onCheckedChange={(checked) => onChange({ ...rule, caseSensitive: checked })}
            />
            {t('validationEditor.ruleCard.caseSensitive')}
          </label>

          <label className="flex items-center gap-2 text-xs">
            {t('validationEditor.ruleCard.tolerance')}
            <Input
              type="number"
              min={0}
              step="any"
              value={rule.tolerance ?? 1e-6}
              onChange={(e) => onChange({ ...rule, tolerance: Math.max(0, Number.parseFloat(e.target.value) || 0) })}
              className="h-7 w-32 text-xs font-mono"
            />
          </label>

          <div className="flex items-center gap-2 text-xs">
            {t('validationEditor.ruleCard.cardinalityMin')}
            <Input
              type="number"
              min={0}
              value={rule.cardinality?.minApplicable ?? ''}
              placeholder={t('validationEditor.ruleCard.cardinalityAny')}
              onChange={(e) => {
                const raw = e.target.value;
                const minApplicable = raw === '' ? undefined : Math.max(0, Number.parseInt(raw, 10) || 0);
                const cardinality = { ...rule.cardinality, minApplicable };
                onChange({ ...rule, cardinality: cleanCardinality(cardinality) });
              }}
              className="h-7 w-20 text-xs font-mono"
            />
            {t('validationEditor.ruleCard.cardinalityMax')}
            <Input
              type="number"
              min={0}
              value={rule.cardinality?.maxApplicable ?? ''}
              placeholder={t('validationEditor.ruleCard.cardinalityAny')}
              onChange={(e) => {
                const raw = e.target.value;
                const maxApplicable = raw === '' ? undefined : Math.max(0, Number.parseInt(raw, 10) || 0);
                const cardinality = { ...rule.cardinality, maxApplicable };
                onChange({ ...rule, cardinality: cleanCardinality(cardinality) });
              }}
              className="h-7 w-20 text-xs font-mono"
            />
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

function cleanCardinality(
  c: { minApplicable?: number; maxApplicable?: number },
): InformationRule['cardinality'] {
  if (c.minApplicable === undefined && c.maxApplicable === undefined) return undefined;
  return c;
}

function SeverityToggle({ value, onChange }: { value: 'error' | 'warning'; onChange: (v: 'error' | 'warning') => void }) {
  const { t } = useTranslation();
  return (
    <div className="inline-flex rounded border border-zinc-200 bg-white p-0.5 text-2xs dark:border-zinc-800 dark:bg-zinc-950">
      {(['error', 'warning'] as const).map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => onChange(s)}
          className={`rounded px-2 py-0.5 font-medium transition-colors ${
            value === s ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {t(`validationEditor.severity.${s}`)}
        </button>
      ))}
    </div>
  );
}

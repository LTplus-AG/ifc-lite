/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `RequirementEditor` — the per-kind requirement fields (#5138 plan §6):
 * a segmented control for Element / Unique / Aggregate / Compare / Unit, then
 * the fields that kind needs. Switching kind keeps the CURRENT rule's
 * `applicability` untouched — only `requirement` changes — the invariant
 * `RuleSetEditor.kinds.test.tsx` locks in.
 *
 * Unique/Aggregate/Compare additionally get the `requirement-text.ts`
 * round-trip: a text field mirrors `requirementToText(requirement)` and,
 * on blur/Enter, replaces the requirement via `parseRequirementText` — a
 * bad token shows inline instead of silently discarding the edit.
 */

import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import type { FilterRule } from '@ifc-lite/rules';
import { ELEMENT_REQUIREMENT_KINDS } from '@ifc-lite/rules';
import type { Requirement, RuleBlock } from '@ifc-lite/rules';
import { requirementToText, parseRequirementText, type TextRequirement } from '@ifc-lite/rules';
import { NUMERIC_OPS, OpDropdown } from '../SearchModal.filter.editors.shared';
import { RuleBlockEditor } from './RuleBlockEditor';
import { SubjectPicker } from './SubjectPicker';
import type { FilterGroupEditorModel } from '../FilterGroupEditor';
import { useTranslation } from '@/i18n';

const KINDS = ['element', 'unique', 'aggregate', 'compare', 'unit'] as const;
type RequirementKind = (typeof KINDS)[number];
const AGGREGATE_FNS = ['count', 'sum', 'min', 'max', 'avg'] as const;
/** The subjects that carry a unit (#5300). */
const UNIT_SUBJECT_KINDS = ['property', 'quantity'] as const;

function emptyBlock(): RuleBlock {
  return { groups: [{ rules: [], combinator: 'AND' }], authoredAs: 'chips' };
}

function blankRequirementOfKind(kind: RequirementKind): Requirement {
  switch (kind) {
    case 'element': return { kind: 'element', block: emptyBlock() };
    case 'unique': return { kind: 'unique', subject: { kind: 'name' } };
    case 'aggregate': return { kind: 'aggregate', fn: 'count', op: 'gte', value: 1 };
    case 'compare': return { kind: 'compare', left: { kind: 'name' }, right: { kind: 'name' }, op: 'eq' };
    case 'unit': return { kind: 'unit', subject: { kind: 'quantity', setName: '', quantityName: '' }, unit: '' };
  }
}

export interface RequirementEditorProps {
  requirement: Requirement;
  onChange: (next: Requirement) => void;
  models: ReadonlyArray<FilterGroupEditorModel>;
  schemaVersion?: string;
}

export function RequirementEditor({ requirement, onChange, models, schemaVersion }: RequirementEditorProps) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-2">
      <div className="inline-flex self-start rounded border border-zinc-200 bg-white p-0.5 text-2xs dark:border-zinc-800 dark:bg-zinc-950">
        {KINDS.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => k !== requirement.kind && onChange(blankRequirementOfKind(k))}
            className={`rounded px-2 py-0.5 font-medium transition-colors ${
              requirement.kind === k
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {t(`validationEditor.requirementKind.${k}`)}
          </button>
        ))}
      </div>

      {requirement.kind === 'element' && (
        <RuleBlockEditor
          block={requirement.block}
          onChange={(block) => onChange({ kind: 'element', block })}
          allowedKinds={ELEMENT_REQUIREMENT_KINDS as ReadonlySet<FilterRule['kind']>}
          models={models}
          schemaVersion={schemaVersion}
          foldBetween
        />
      )}

      {requirement.kind === 'unique' && (
        <div className="flex flex-wrap items-center gap-2">
          <SubjectPicker
            subject={requirement.subject}
            onChange={(subject) => onChange({ ...requirement, subject })}
            aria-label={t('validationEditor.unique.subjectAriaLabel')}
          />
          <ScopeToggle
            value={requirement.scope ?? 'federation'}
            onChange={(scope) => onChange({ ...requirement, scope: scope === 'federation' ? undefined : scope })}
          />
        </div>
      )}

      {requirement.kind === 'aggregate' && (
        <AggregateFields requirement={requirement} onChange={onChange} models={models} schemaVersion={schemaVersion} />
      )}

      {requirement.kind === 'compare' && (
        <div className="flex flex-wrap items-center gap-2">
          <SubjectPicker
            subject={requirement.left}
            onChange={(left) => onChange({ ...requirement, left })}
            singleValuedOnly
            aria-label={t('validationEditor.compare.leftAriaLabel')}
          />
          <OpDropdown ops={NUMERIC_OPS} value={requirement.op} onChange={(op) => onChange({ ...requirement, op })} />
          <SubjectPicker
            subject={requirement.right}
            onChange={(right) => onChange({ ...requirement, right })}
            singleValuedOnly
            aria-label={t('validationEditor.compare.rightAriaLabel')}
          />
          <ValueTypeToggle
            value={requirement.valueType ?? 'number'}
            onChange={(valueType) => onChange({ ...requirement, valueType: valueType === 'number' ? undefined : valueType })}
          />
        </div>
      )}

      {requirement.kind === 'unit' && (
        <div className="flex flex-wrap items-center gap-2">
          <SubjectPicker
            subject={requirement.subject}
            onChange={(subject) => {
              if (subject.kind === 'property' || subject.kind === 'quantity') onChange({ ...requirement, subject });
            }}
            onlyKinds={UNIT_SUBJECT_KINDS}
            aria-label={t('validationEditor.unit.subjectAriaLabel')}
          />
          <span className="text-xs text-muted-foreground">{t('validationEditor.unit.recordedIn')}</span>
          <Input
            value={requirement.unit}
            onChange={(e) => onChange({ ...requirement, unit: e.target.value })}
            placeholder={t('validationEditor.unit.unitPlaceholder')}
            aria-label={t('validationEditor.unit.unitAriaLabel')}
            aria-invalid={requirement.unit.trim().length === 0}
            className={`h-7 w-20 text-xs font-mono ${requirement.unit.trim().length === 0 ? 'border-red-500' : ''}`}
          />
        </div>
      )}

      {requirement.kind !== 'element' && requirement.kind !== 'unit' && (
        <RequirementTextField requirement={requirement} onChange={onChange} />
      )}
    </div>
  );
}

function AggregateFields({
  requirement,
  onChange,
  models,
  schemaVersion,
}: {
  requirement: Extract<Requirement, { kind: 'aggregate' }>;
  onChange: (next: Requirement) => void;
  models: ReadonlyArray<FilterGroupEditorModel>;
  schemaVersion?: string;
}) {
  const { t } = useTranslation();
  const hasGroupBy = requirement.groupBy !== undefined;
  const hasUniverse = requirement.groupBy?.universe !== undefined;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <OpDropdown
          ops={AGGREGATE_FNS}
          value={requirement.fn}
          onChange={(fn) => onChange({ ...requirement, fn, ...(fn === 'count' ? { subject: undefined } : {}) })}
        />
        {requirement.fn !== 'count' && (
          <SubjectPicker
            subject={requirement.subject ?? { kind: 'quantity', setName: '', quantityName: '' }}
            onChange={(subject) => onChange({ ...requirement, subject })}
            singleValuedOnly
            aria-label={t('validationEditor.aggregate.subjectAriaLabel')}
          />
        )}
        <OpDropdown ops={NUMERIC_OPS} value={requirement.op} onChange={(op) => onChange({ ...requirement, op })} />
        <Input
          type="number"
          value={requirement.value}
          onChange={(e) => onChange({ ...requirement, value: Number.parseFloat(e.target.value) || 0 })}
          className="h-7 w-24 text-xs font-mono"
        />
      </div>

      <label className="flex items-center gap-2 text-xs">
        <Switch
          checked={hasGroupBy}
          onCheckedChange={(checked) =>
            onChange({
              ...requirement,
              groupBy: checked ? { subject: { kind: 'parent' } } : undefined,
            })
          }
        />
        {t('validationEditor.aggregate.groupByToggle')}
      </label>

      {hasGroupBy && requirement.groupBy && (
        <div className="flex flex-col gap-2 border-l-2 border-zinc-200 pl-3 dark:border-zinc-800">
          <SubjectPicker
            subject={requirement.groupBy.subject}
            onChange={(subject) => onChange({ ...requirement, groupBy: { ...requirement.groupBy!, subject } })}
            aria-label={t('validationEditor.aggregate.groupBySubjectAriaLabel')}
          />
          <label className="flex items-center gap-2 text-xs">
            <Switch
              checked={hasUniverse}
              onCheckedChange={(checked) =>
                onChange({
                  ...requirement,
                  groupBy: { ...requirement.groupBy!, universe: checked ? emptyBlock() : undefined },
                })
              }
            />
            {t('validationEditor.aggregate.universeToggle')}
          </label>
          {hasUniverse && requirement.groupBy.universe && (
            <RuleBlockEditor
              block={requirement.groupBy.universe}
              onChange={(universe) => onChange({ ...requirement, groupBy: { ...requirement.groupBy!, universe } })}
              models={models}
              schemaVersion={schemaVersion}
            />
          )}
        </div>
      )}
    </div>
  );
}

function ScopeToggle({ value, onChange }: { value: 'perModel' | 'federation'; onChange: (v: 'perModel' | 'federation') => void }) {
  const { t } = useTranslation();
  return (
    <div className="inline-flex rounded border border-zinc-200 bg-white p-0.5 text-2xs dark:border-zinc-800 dark:bg-zinc-950">
      {(['federation', 'perModel'] as const).map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => onChange(s)}
          className={`rounded px-2 py-0.5 font-medium transition-colors ${
            value === s ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {t(`validationEditor.unique.scope.${s}`)}
        </button>
      ))}
    </div>
  );
}

function ValueTypeToggle({ value, onChange }: { value: 'number' | 'date'; onChange: (v: 'number' | 'date') => void }) {
  const { t } = useTranslation();
  return (
    <div className="inline-flex rounded border border-zinc-200 bg-white p-0.5 text-2xs dark:border-zinc-800 dark:bg-zinc-950">
      {(['number', 'date'] as const).map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          className={`rounded px-2 py-0.5 font-medium transition-colors ${
            value === v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {t(`validationEditor.compare.valueType.${v}`)}
        </button>
      ))}
    </div>
  );
}

/** `requirementToText`/`parseRequirementText` round-trip (plan §6): mirrors
 *  the structured fields, and lets an author type the requirement
 *  directly. A parse failure is shown inline and never overwrites
 *  `requirement` — same "say what stopped it" posture as the selector
 *  field (#4091). */
function RequirementTextField({
  requirement,
  onChange,
}: {
  requirement: TextRequirement;
  onChange: (next: Requirement) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const text = draft ?? requirementToText(requirement);

  const apply = () => {
    if (draft === null) return;
    const result = parseRequirementText(draft);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    setDraft(null);
    onChange(result.requirement);
  };

  return (
    <div className="flex flex-col gap-1">
      <Input
        value={text}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={apply}
        onKeyDown={(e) => { if (e.key === 'Enter') apply(); }}
        aria-label={t('validationEditor.requirementText.ariaLabel')}
        spellCheck={false}
        className="h-7 font-mono text-xs"
      />
      {error && <p role="alert" className="text-2xs text-destructive">{error}</p>}
    </div>
  );
}

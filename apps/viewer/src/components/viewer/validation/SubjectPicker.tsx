/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `SubjectPicker` — pick a `Subject` (#5138 plan §3: a `FilterRule` minus
 * its operator/operand), for the `unique`/`aggregate`/`compare`
 * requirement kinds' subject fields. Reuses `RuleRow`'s KIND label set and
 * `useFilterRuleOptions`' pset/qto discovery (the same schema material the
 * chip editor draws its property/quantity dropdowns from) with the op and
 * value controls hidden — a subject has neither, by definition
 * (`rule-set.ts`'s `SubjectOf<R> = Omit<R, 'op' | 'value' | 'values' |
 * 'valueKind'>`).
 */

import { useMemo } from 'react';
import { ComboInput } from '@/components/ui/combo-input';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { useFilterRuleOptions } from '@/hooks/useFilterRuleOptions';
import type { FilterRule } from '@ifc-lite/rules';
import type { Subject } from '@ifc-lite/rules';
import { useTranslation } from '@/i18n';

/** Every `Subject` kind `rule-set-io-subject.ts` accepts — `model`/
 *  `modelTag`/`elevation` are applicability-only concerns, never a
 *  checkable fact about one element, so they have no `Subject` form. */
const SUBJECT_KINDS = [
  'attribute', 'property', 'quantity', 'classification',
  'name', 'material', 'storey', 'parent', 'type', 'ifcType', 'predefinedType', 'globalId',
] as const;

const MULTI_VALUED: ReadonlySet<string> = new Set(['material', 'classification', 'parent']);

/** `validationEditor.subjectKind.<kind>` — every label goes through `t()`
 *  at its call site (a bot review on this PR caught an earlier version
 *  hardcoding English text in a lookup table that never reached `t`). */
function subjectKindLabel(t: ReturnType<typeof useTranslation>['t'], kind: (typeof SUBJECT_KINDS)[number]): string {
  return t(`validationEditor.subjectKind.${kind}`);
}

function blankSubjectOfKind(kind: (typeof SUBJECT_KINDS)[number]): Subject {
  switch (kind) {
    case 'attribute': return { kind: 'attribute', name: '' };
    case 'property': return { kind: 'property', setName: '', propertyName: '' };
    case 'quantity': return { kind: 'quantity', setName: '', quantityName: '' };
    case 'classification': return { kind: 'classification' };
    default: return { kind };
  }
}

export interface SubjectPickerProps {
  subject: Subject;
  onChange: (next: Subject) => void;
  /** Restricted to subjects `isSingleValuedSubject` accepts — `sum`/`min`/
   *  `max`/`avg`/`compare` (plan §3: a list of material names has no
   *  numeric meaning). Omitted for `unique`/`count`/`groupBy`, which allow
   *  every kind. */
  singleValuedOnly?: boolean;
  'aria-label'?: string;
}

export function SubjectPicker({ subject, onChange, singleValuedOnly, 'aria-label': ariaLabel }: SubjectPickerProps) {
  const { t } = useTranslation();
  const kinds = singleValuedOnly ? SUBJECT_KINDS.filter((k) => !MULTI_VALUED.has(k)) : SUBJECT_KINDS;

  // Drives the SAME lazy pset/qto/value discovery a `RuleRow` triggers —
  // pass a synthetic rule so `useFilterRuleOptions` fires its property/
  // quantity effect for whichever kind is currently selected.
  const syntheticRules = useMemo((): FilterRule[] => {
    if (subject.kind === 'property') {
      return [{ kind: 'property', setName: subject.setName, propertyName: subject.propertyName, op: 'isSet', value: '' }];
    }
    if (subject.kind === 'quantity') {
      return [{ kind: 'quantity', setName: subject.setName, quantityName: subject.quantityName, op: 'gt', value: 0 }];
    }
    return [];
  }, [subject]);
  const { psetQto } = useFilterRuleOptions(syntheticRules);

  const psetNames = useMemo(() => (psetQto ? psetQto.psets.map(([n]) => n) : []), [psetQto]);
  const propNames = useMemo(() => {
    if (!psetQto || subject.kind !== 'property') return [];
    const entry = psetQto.psets.find(([n]) => n === subject.setName);
    return entry ? Array.from(entry[1]) : [];
  }, [psetQto, subject]);
  const qsetNames = useMemo(() => (psetQto ? psetQto.qtos.map(([n]) => n) : []), [psetQto]);
  const qtyNames = useMemo(() => {
    if (!psetQto || subject.kind !== 'quantity') return [];
    const entry = psetQto.qtos.find(([n]) => n === subject.setName);
    return entry ? entry[1].map(([n]) => n) : [];
  }, [psetQto, subject]);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" aria-label={ariaLabel}>
            {subjectKindLabel(t, subject.kind as (typeof SUBJECT_KINDS)[number])}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {kinds.map((k) => (
            <DropdownMenuItem key={k} onSelect={() => onChange(blankSubjectOfKind(k))}>
              {subjectKindLabel(t, k)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {subject.kind === 'attribute' && (
        <Input
          placeholder={t('validationEditor.subjectPicker.attributeNamePlaceholder')}
          value={subject.name}
          onChange={(e) => onChange({ ...subject, name: e.target.value })}
          className="h-7 w-44 text-xs font-mono"
        />
      )}

      {subject.kind === 'property' && (
        <>
          <ComboInput
            placeholder={t('validationEditor.subjectPicker.psetNamePlaceholder')}
            value={subject.setName}
            options={psetNames}
            className="h-7 w-48 text-xs font-mono"
            onChange={(next) => onChange({ ...subject, setName: next, setNameKind: undefined })}
          />
          <span className="text-muted-foreground">.</span>
          <ComboInput
            placeholder={t('validationEditor.subjectPicker.propertyNamePlaceholder')}
            value={subject.propertyName}
            options={propNames}
            className="h-7 w-40 text-xs font-mono"
            onChange={(next) => onChange({ ...subject, propertyName: next, propertyNameKind: undefined })}
          />
        </>
      )}

      {subject.kind === 'quantity' && (
        <>
          <ComboInput
            placeholder={t('validationEditor.subjectPicker.qsetNamePlaceholder')}
            value={subject.setName}
            options={qsetNames}
            className="h-7 w-48 text-xs font-mono"
            onChange={(next) => onChange({ ...subject, setName: next, setNameKind: undefined })}
          />
          <span className="text-muted-foreground">.</span>
          <ComboInput
            placeholder={t('validationEditor.subjectPicker.quantityNamePlaceholder')}
            value={subject.quantityName}
            options={qtyNames}
            className="h-7 w-40 text-xs font-mono"
            onChange={(next) => onChange({ ...subject, quantityName: next, quantityNameKind: undefined })}
          />
        </>
      )}

      {subject.kind === 'classification' && (
        <Input
          placeholder={t('validationEditor.subjectPicker.classificationSystemPlaceholder')}
          value={subject.system ?? ''}
          onChange={(e) => onChange({ ...subject, system: e.target.value || undefined })}
          className="h-7 w-44 text-xs font-mono"
        />
      )}
    </div>
  );
}

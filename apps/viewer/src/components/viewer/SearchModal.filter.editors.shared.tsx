/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Op constants and the `OpDropdown` widget shared by every per-rule chip
 * editor. Split out of `SearchModal.filter.editors.tsx` so both it and
 * `SearchModal.filter.editors.identity.tsx` (the `globalId`/`attribute`
 * editors, #4094) can depend on this without importing each other.
 */

import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import type { SetOp, StringOp, ValueOp, NumericOp, ClassificationOp } from '@ifc-lite/rules';
import { useTranslation } from '@/i18n';
import { FILTER_OPERATOR_LABEL_KEYS } from '@/lib/filter-operator-labels';

export const SET_OPS: SetOp[] = ['in', 'notIn'];
export const STRING_OPS: StringOp[] = ['eq', 'ne', 'contains', 'notContains', 'startsWith', 'matches', 'notMatches'];
export const VALUE_OPS: ValueOp[] = [
  'eq', 'ne', 'contains', 'notContains', 'matches', 'notMatches', 'gt', 'gte', 'lt', 'lte', 'isSet', 'isNotSet',
];
export const NUMERIC_OPS: NumericOp[] = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'];
export const CLASSIFICATION_OPS: ClassificationOp[] = [
  'contains', 'eq', 'ne', 'notContains', 'matches', 'notMatches', 'isSet', 'isNotSet',
];

export function OpDropdown<T extends string>({
  ops,
  value,
  onChange,
}: {
  ops: ReadonlyArray<T>;
  value: T;
  onChange: (next: T) => void;
}) {
  const { t } = useTranslation();
  const label = (operator: string) => operator in FILTER_OPERATOR_LABEL_KEYS
    ? t(FILTER_OPERATOR_LABEL_KEYS[operator as keyof typeof FILTER_OPERATOR_LABEL_KEYS])
    : operator;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 min-w-[3.5rem] gap-1 text-xs font-mono">
          {label(value)}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {ops.map((op) => (
          <DropdownMenuItem key={op} onSelect={() => onChange(op)} className="font-mono">
            {label(op)}
            <span className="ml-2 text-2xs text-muted-foreground">{op}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface SetRuleEditorProps {
  values: string[];
  op: SetOp;
  options: Array<{ label: string; value: string }>;
  onChange: (values: string[], op: SetOp) => void;
}

/** Op + multi-select over `options`, with removable value chips. */
export function SetRuleEditor({ values, op, options, onChange }: SetRuleEditorProps) {
  const { t } = useTranslation();
  const toggle = (v: string) => {
    const next = values.includes(v) ? values.filter((x) => x !== v) : [...values, v];
    onChange(next, op);
  };
  return (
    <>
      <OpDropdown ops={SET_OPS} value={op} onChange={(next) => onChange(values, next)} />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-7 gap-1 text-xs font-mono">
            {values.length === 0
              ? t('searchModal.filterEditors.pickValues')
              : t('searchModal.filterEditors.selectedCount', { count: values.length })}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
          {options.length === 0 && (
            <DropdownMenuItem disabled className="text-muted-foreground italic">
              {t('searchModal.filterEditors.noOptionsAvailable')}
            </DropdownMenuItem>
          )}
          {options.map((o) => (
            <DropdownMenuItem
              key={o.value}
              onSelect={(e) => {
                // Keep the menu open for multi-select.
                e.preventDefault();
                toggle(o.value);
              }}
              className="font-mono"
            >
              <span className="mr-2 inline-block w-3 text-center">
                {values.includes(o.value) ? '✓' : ''}
              </span>
              {o.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {values.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {values.map((v) => (
            <span
              key={v}
              className="inline-flex items-center gap-1 rounded bg-zinc-100 px-1.5 py-0.5 text-2xs font-mono dark:bg-zinc-800"
            >
              {v}
              <button
                type="button"
                aria-label={t('searchModal.filterEditors.removeValueAriaLabel', { value: v })}
                onClick={() => toggle(v)}
                className="text-muted-foreground hover:text-foreground"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </>
  );
}

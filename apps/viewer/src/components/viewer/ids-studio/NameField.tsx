/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A name-bearing facet field (entity, predefined type, attribute, property
 * set, property, data type): a schema picker for a literal name, or the full
 * value editor when the author wants a pattern or a list. Patterns on names
 * are valid IDS; only literals are grounded by the gate.
 */

import { useState, type ReactNode } from 'react';
import type { IDSConstraint } from '@ifc-lite/ids';
import type { ValueInput } from '@ifc-lite/ids-authoring';
import { useTranslation } from '@/i18n';
import { NamePicker, type PickerOption } from './NamePicker';
import { ValueEditor } from './ValueEditor';

interface NameFieldProps {
  label: string;
  constraint: IDSConstraint | undefined;
  options: readonly PickerOption[];
  required?: boolean;
  labelAction?: ReactNode;
  /** A literal picked or typed. */
  onPick: (name: string) => void;
  onCommit: (input: ValueInput | null) => void;
  /** Literal names are stored upper case (entity, data type); show the schema spelling. */
  display?: (stored: string) => string;
}

export function NameField({ label, constraint, options, required, labelAction, onPick, onCommit, display }: NameFieldProps) {
  const { t } = useTranslation();
  const literal = !constraint || constraint.type === 'simpleValue';
  const [advanced, setAdvanced] = useState(!literal);
  const toggle = <button type="button" className="text-2xs text-primary hover:underline" aria-pressed={advanced}
    onClick={() => setAdvanced((v) => !v)}>{advanced ? t('idsStudio.field.usePicker') : t('idsStudio.field.useRestriction')}</button>;
  if (advanced || !literal) {
    return <div className="space-y-0.5">
      {literal && <div className="flex justify-end">{toggle}</div>}
      <ValueEditor label={label} constraint={constraint} required={required} onCommit={onCommit} />
    </div>;
  }
  const value = constraint?.type === 'simpleValue' ? (display ? display(constraint.value) : constraint.value) : '';
  return <div className="space-y-0.5">
    <NamePicker label={label} value={value} options={options} onPick={onPick} emptyText={t('idsStudio.picker.empty')}
      labelAction={<span className="flex items-center gap-2">{labelAction}{toggle}</span>} />
    {!required && constraint && <button type="button" className="text-2xs text-muted-foreground hover:underline" onClick={() => onCommit(null)}>
      {t('idsStudio.field.clear')}
    </button>}
  </div>;
}

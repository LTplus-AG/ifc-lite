/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One property-filter row in `BulkPropertyEditor`, extracted (#5812) so
 * that file does not grow past its size while this row's fields gain real,
 * sr-only labels (no visible label fits this compact row): `Field` for the
 * three `Input`s and for the operator `Select` — see
 * `property-editor-new-property-dialog.tsx`'s header for how `Field` labels
 * a `Select` (via `FieldContext`, since a Radix `Select.Root` is headless
 * and cloning props onto it directly would reach nothing).
 */

import { Trash2 } from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { FilterOperator } from '@ifc-lite/mutations';
import { useTranslation } from '@/i18n';
import { FILTER_OPERATORS } from './bulk-property-editor-options';

export interface PropertyFilterUI {
  id: string;
  psetName: string;
  propName: string;
  operator: FilterOperator;
  value: string;
}

export interface BulkFilterRowProps {
  filter: PropertyFilterUI;
  onUpdate: (id: string, field: keyof PropertyFilterUI, value: string) => void;
  onRemove: (id: string) => void;
}

export function BulkFilterRow({ filter, onUpdate, onRemove }: BulkFilterRowProps) {
  const { t } = useTranslation();
  const isValueless = filter.operator === 'IS_NULL' || filter.operator === 'IS_NOT_NULL';

  return (
    <div className="flex items-center gap-2 p-2 border rounded-md bg-muted/30">
      <Field label={t('bulkPropertyEditor.psetOptional')} labelClassName="sr-only">
        <Input
          placeholder={t('bulkPropertyEditor.psetOptional')}
          value={filter.psetName}
          onChange={(e) => onUpdate(filter.id, 'psetName', e.target.value)}
          className="h-8 text-xs w-28"
        />
      </Field>
      <Field label={t('bulkPropertyEditor.propertyName')} labelClassName="sr-only">
        <Input
          placeholder={t('bulkPropertyEditor.propertyName')}
          value={filter.propName}
          onChange={(e) => onUpdate(filter.id, 'propName', e.target.value)}
          className="h-8 text-xs flex-1"
        />
      </Field>
      <Field label={t('bulkPropertyEditor.filterOperator')} labelClassName="sr-only">
        <Select
          value={filter.operator}
          onValueChange={(v) => onUpdate(filter.id, 'operator', v)}
        >
          <SelectTrigger className="h-8 w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FILTER_OPERATORS.map((op) => (
              <SelectItem key={op.value} value={op.value}>{t(op.labelKey)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {!isValueless && (
        <Field label={t('bulkPropertyEditor.value')} labelClassName="sr-only">
          <Input
            placeholder={t('bulkPropertyEditor.value')}
            value={filter.value}
            onChange={(e) => onUpdate(filter.id, 'value', e.target.value)}
            className="h-8 text-xs w-20"
          />
        </Field>
      )}
      <IconButton label={t('bulkPropertyEditor.removeFilter')} className="h-8 w-8" onClick={() => onRemove(filter.id)}>
        <Trash2 className="h-3 w-3 text-destructive" />
      </IconButton>
    </div>
  );
}

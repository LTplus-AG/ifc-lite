/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The "Action Configuration" section of `BulkPropertyEditor`, extracted
 * (#5812) so that file does not grow past its size while these fields gain
 * real labels — every field, including its `Select`s, is wrapped in `Field`
 * (see `property-editor-new-property-dialog.tsx`'s header for how `Field`
 * labels a `Select` via `FieldContext` rather than by cloning props onto
 * it).
 *
 * `targetProp`/`targetPset` use a native `<input list=...>` datalist (not
 * `Select`+`SelectContent`) because the option set comes from live model
 * discovery and the user may type a value the model doesn't have yet;
 * `Field` labels those directly since `<Input>` forwards `id`/`aria-*` onto
 * the real `<input>`. Each field keeps its own wrapping `<div>` (rather
 * than letting `Field` sit directly in the `grid-cols-2` row) so an
 * invisible sibling `<datalist>` never becomes an extra, layout-shifting
 * grid track.
 */

import { Fragment, type ReactNode } from 'react';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { BULK_WRITABLE_ATTRIBUTES } from '@ifc-lite/mutations';
import { PropertyValueType } from '@ifc-lite/data';
import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';

type ActionType = 'SET_PROPERTY' | 'DELETE_PROPERTY' | 'SET_ATTRIBUTE';

export interface BulkActionConfigProps {
  actionType: ActionType;
  onActionTypeChange: (type: ActionType) => void;
  targetPset: string;
  onTargetPsetChange: (value: string) => void;
  targetProp: string;
  onTargetPropChange: (value: string) => void;
  targetValue: string;
  onTargetValueChange: (value: string) => void;
  valueType: PropertyValueType;
  onValueTypeChange: (type: PropertyValueType) => void;
  psetOptions: string[];
  propOptions: string[];
}

export function BulkActionConfig({
  actionType,
  onActionTypeChange,
  targetPset,
  onTargetPsetChange,
  targetProp,
  onTargetPropChange,
  targetValue,
  onTargetValueChange,
  valueType,
  onValueTypeChange,
  psetOptions,
  propOptions,
}: BulkActionConfigProps) {
  const { t, locale } = useTranslation();

  const found = (count: number): ReactNode =>
    count > 0 ? <span className="ml-1 text-muted-foreground">{t('bulkPropertyEditor.found', { count, countDisplay: formatLocaleNumber(locale, count) })}</span> : null;

  const propertyLabel = actionType === 'SET_ATTRIBUTE' ? t('bulkPropertyEditor.attribute') : t('bulkPropertyEditor.propertyNameLabel');

  return (
    <Fragment>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Field label={t('bulkPropertyEditor.actionType')}>
            <Select
              value={actionType}
              onValueChange={(v) => { if ((v === 'SET_ATTRIBUTE') !== (actionType === 'SET_ATTRIBUTE')) onTargetPropChange(''); onActionTypeChange(v as ActionType); }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="SET_PROPERTY">{t('bulkPropertyEditor.setProperty')}</SelectItem>
                <SelectItem value="DELETE_PROPERTY">{t('bulkPropertyEditor.deleteProperty')}</SelectItem>
                <SelectItem value="SET_ATTRIBUTE">{t('bulkPropertyEditor.setAttribute')}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>

        {actionType !== 'SET_ATTRIBUTE' && (
          <div className="space-y-2">
            <Field label={<>{t('bulkPropertyEditor.propertySet')}{found(psetOptions.length)}</>}>
              <Input
                list="pset-options"
                aria-label={t('bulkPropertyEditor.propertySet')}
                placeholder={t('bulkPropertyEditor.psetPlaceholder')}
                value={targetPset}
                onChange={(e) => onTargetPsetChange(e.target.value)}
              />
            </Field>
            <datalist id="pset-options">
              {psetOptions.map((pset) => (
                <option key={pset} value={pset}>{pset}</option>
              ))}
            </datalist>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Field label={<>{propertyLabel}{actionType !== 'SET_ATTRIBUTE' && found(propOptions.length)}</>}>
            {actionType === 'SET_ATTRIBUTE' ? (
              <Select value={targetProp} onValueChange={onTargetPropChange}>
                <SelectTrigger>
                  <SelectValue placeholder={t('bulkPropertyEditor.selectAttribute')} />
                </SelectTrigger>
                <SelectContent>
                  {/* Exact EXPRESS names, never translated or aliased; the engine's own list (#5867). */}
                  {BULK_WRITABLE_ATTRIBUTES.map((attribute) => (
                    <SelectItem key={attribute} value={attribute}>{attribute}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                list="prop-options"
                aria-label={propertyLabel}
                placeholder={t('bulkPropertyEditor.propertyPlaceholder')}
                value={targetProp}
                onChange={(e) => onTargetPropChange(e.target.value)}
              />
            )}
          </Field>
          {actionType !== 'SET_ATTRIBUTE' && (
            <datalist id="prop-options">
              {propOptions.map((prop) => (
                <option key={prop} value={prop}>{prop}</option>
              ))}
            </datalist>
          )}
        </div>

        {actionType !== 'DELETE_PROPERTY' && (
          <div className="space-y-2">
            <Field label={t('bulkPropertyEditor.newValue')}>
              <Input
                placeholder={t('bulkPropertyEditor.value')}
                value={targetValue}
                onChange={(e) => onTargetValueChange(e.target.value)}
              />
            </Field>
          </div>
        )}
      </div>

      {actionType === 'SET_PROPERTY' && (
        <div className="space-y-2">
          <Field label={t('bulkPropertyEditor.valueType')}>
            <Select
              value={valueType.toString()}
              onValueChange={(v) => onValueTypeChange(parseInt(v) as PropertyValueType)}
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={PropertyValueType.String.toString()}>{t('bulkPropertyEditor.string')}</SelectItem>
                <SelectItem value={PropertyValueType.Real.toString()}>{t('bulkPropertyEditor.real')}</SelectItem>
                <SelectItem value={PropertyValueType.Integer.toString()}>{t('bulkPropertyEditor.integer')}</SelectItem>
                <SelectItem value={PropertyValueType.Boolean.toString()}>{t('bulkPropertyEditor.boolean')}</SelectItem>
                <SelectItem value={PropertyValueType.Label.toString()}>{t('bulkPropertyEditor.label')}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
      )}
    </Fragment>
  );
}

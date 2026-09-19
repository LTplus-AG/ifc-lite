/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { PropertyValueType } from '@ifc-lite/data';
import { resolve } from '@/i18n/registry';

/** A parse failure retains semantic inputs so mounted UI can retranslate it live. */
export type BulkParseResult = { ok: true; value: string | number | boolean } | {
  ok: false;
  message: string;
  input: string;
  typeKey: 'bulkPropertyEditor.real' | 'bulkPropertyEditor.integer';
};

/** Parse a SET_PROPERTY value without fabricating numeric zero on invalid input. */
export function parseBulkSetPropertyValue(
  targetValue: string,
  valueType: PropertyValueType,
  t: typeof resolve = resolve,
): BulkParseResult {
  if (valueType === PropertyValueType.Real || valueType === PropertyValueType.Integer) {
    const typeKey = valueType === PropertyValueType.Real ? 'bulkPropertyEditor.real' : 'bulkPropertyEditor.integer';
    const parsed = valueType === PropertyValueType.Real ? parseFloat(targetValue) : parseInt(targetValue, 10);
    if (targetValue.trim() === '' || Number.isNaN(parsed)) {
      return {
        ok: false,
        message: t('bulkPropertyEditor.invalidValue', { value: targetValue, type: t(typeKey) }),
        input: targetValue,
        typeKey,
      };
    }
    return { ok: true, value: parsed };
  }
  if (valueType === PropertyValueType.Boolean) {
    return { ok: true, value: targetValue.toLowerCase() === 'true' || targetValue === '1' };
  }
  return { ok: true, value: targetValue };
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #7070: native field constraints for portable model-change drafts. */
import { changeKey, parseModelChangeBatch, type ChangeScalar, type ModelChange } from '@ifc-lite/ai/artifacts';

export interface ProposalField {
  readonly native: ModelChange;
  readonly expectedColumn: string;
  readonly allowedValues: readonly ChangeScalar[];
}
const sampleTarget = { globalId: '0000000000000000000000' };
const fieldKey = (change: ModelChange) => changeKey({ ...change, target: sampleTarget });
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Native parsing checks each allowed value's IFC type, rather than copying that validator. */
export function proposalFields(raw: unknown, columns: readonly string[]): ProposalField[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > 50) throw new Error('Select 1 to 50 native fields for the proposal');
  const seen = new Set<string>();
  return raw.map((value, index) => {
    if (!record(value)) throw new Error(`Field ${index + 1} must be an object`);
    const { expectedColumn, allowedValues, ...binding } = value;
    const keys = ['op', 'name', 'pset', 'qset', 'dataType'];
    if (Object.keys(binding).some(key => !keys.includes(key))) throw new Error(`Field ${index + 1} has an unknown constraint`);
    if (typeof expectedColumn !== 'string' || !columns.includes(expectedColumn)) throw new Error(`Field ${index + 1} needs a selected expectedColumn`);
    const deleting = binding.op === 'property.delete';
    if (deleting ? allowedValues !== undefined : !Array.isArray(allowedValues) || !allowedValues.length || allowedValues.length > 20) {
      throw new Error('Set fields need 1 to 20 allowedValues; delete fields must omit them');
    }
    const values = deleting ? ['existing value'] : allowedValues as unknown[];
    const parsed = values.map(candidate => parseModelChangeBatch(JSON.stringify({ version: 1, kind: 'model.changes', title: 'Field constraint', changes: [{
      ...binding, target: sampleTarget, expected: deleting ? 'existing value' : binding.op === 'attribute.set' ? '' : binding.op === 'quantity.set' ? 0 : null,
      ...(!deleting ? { value: candidate } : {}),
    }] })).changes[0]);
    const native = parsed[0];
    // Cross-operation fields must not smuggle unused binding names into the prompt.
    const allowedKeys = native.op === 'property.set' ? ['op', 'name', 'pset', 'dataType']
      : native.op === 'property.delete' ? ['op', 'name', 'pset'] : native.op === 'quantity.set' ? ['op', 'name', 'qset'] : ['op', 'name'];
    if (Object.keys(binding).some(key => !allowedKeys.includes(key))) throw new Error(`Field ${index + 1} has a binding for another operation`);
    const key = fieldKey(native);
    if (seen.has(key)) throw new Error('Each native value may have only one field constraint');
    seen.add(key);
    return { native, expectedColumn, allowedValues: deleting ? [] : parsed.map(change => 'value' in change ? change.value : null) };
  });
}

/** Every effect field and candidate value must be explicitly allowed by the graph. */
export function constrainedField(change: ModelChange, fields: readonly ProposalField[]): ProposalField {
  const field = fields.find(candidate => fieldKey(candidate.native) === fieldKey(change) && candidate.native.op === change.op);
  if (!field) throw new Error('The proposed change is outside the selected native fields');
  if (change.op === 'property.set' && field.native.op === 'property.set' && change.dataType !== field.native.dataType) {
    throw new Error('The proposed property dataType differs from its native field constraint');
  }
  if ('value' in change && !field.allowedValues.some(value => Object.is(value, change.value))) throw new Error('The proposed value is outside allowedValues');
  return field;
}

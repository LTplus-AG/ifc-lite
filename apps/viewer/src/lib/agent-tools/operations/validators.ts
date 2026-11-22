/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import Ajv, { type ValidateFunction } from 'ajv';
import { operationInputError } from './input-errors';
import { internal, invalidInput } from './refusals';
const ajv = new Ajv({ strict: true, allErrors: false });
const compiled = new WeakMap<Record<string, unknown>, ValidateFunction>();
export function compileOperationSchema(schema: Record<string, unknown>) {
  let validator = compiled.get(schema);
  if (!validator) { validator = ajv.compile(schema); compiled.set(schema, validator); }
  return validator;
}
function validate(schema: Record<string, unknown>, data: unknown, refuse: (errors: ValidateFunction['errors']) => Error) {
  const validator = compileOperationSchema(schema);
  if (!validator(data)) throw refuse(validator.errors);
}
/** Input that fails its schema is the caller's to fix; a result that fails its own schema is the viewer's bug. */
export function operationValidators(id: string, input: Record<string, unknown>, output: Record<string, unknown>) {
  return { validate: (data: unknown) => validate(input, data, errors => invalidInput('invalid-value', operationInputError(id, input, errors))),
    validateResult: (data: unknown) => validate(output, data, errors => internal(`Invalid ${id} output: ${ajv.errorsText(errors)}`)) };
}

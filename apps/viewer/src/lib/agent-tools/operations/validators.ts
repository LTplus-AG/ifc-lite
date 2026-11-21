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
function validate(schema: Record<string, unknown>, data: unknown, label: string, refuse: (message: string) => Error) {
  const validator = compileOperationSchema(schema);
  if (!validator(data)) throw refuse(`Invalid ${label}: ${ajv.errorsText(validator.errors)}`);
}
function validateInput(id: string, schema: Record<string, unknown>, data: unknown) {
  const validator = compileOperationSchema(schema);
  if (!validator(data)) throw invalidInput('invalid-value', operationInputError(id, schema, validator.errors));
}
/** Input that fails its schema is the caller's to fix; a result that fails its own schema is the viewer's bug. */
export function operationValidators(id: string, input: Record<string, unknown>, output: Record<string, unknown>) {
  return { validate: (data: unknown) => validateInput(id, input, data),
    validateResult: (data: unknown) => validate(output, data, `${id} output`, message => internal(message)) };
}

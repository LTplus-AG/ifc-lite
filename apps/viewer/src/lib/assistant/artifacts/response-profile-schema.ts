/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { NAME_LIMIT } from './artifact-json';
type Schema = Record<string, unknown>;
/** Strict profiles omit optional native fields; null does not mean omitted. */
export const profileObject = (properties: Record<string, Schema>): Schema => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
});
export const profileLiteral = (value: string | number): Schema => ({ type: typeof value === 'number' ? 'integer' : 'string', enum: [value] });
export const profileTitle: Schema = { type: 'string', minLength: 1, maxLength: NAME_LIMIT };

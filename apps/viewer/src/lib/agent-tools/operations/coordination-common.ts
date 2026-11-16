/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { JSONSchemaType } from 'ajv';
import { coordinationOutputSchema } from './coordination-outputs';
import { operation, type Effect, type OperationContext } from './contract';
export function coordination<T>(id: string, description: string, effects: readonly Effect[], schema: JSONSchemaType<T>, handler: (input: T, context: OperationContext) => unknown | Promise<unknown>) {
  return operation({ outputSchema: coordinationOutputSchema(id), policy: { ...(effects.includes('artifact') ? { artifact: 'native-export' as const } : {}), ...(effects.includes('network') ? { network: 'native-provider' as const } : {}) }, id, owner: id.split('.')[0], description, effects,
    capability: effects.every(effect => effect === 'read') ? 'read' : 'commands-and-edits', implementation: 'native-store' }, schema, handler);
}
export const idSchema: JSONSchemaType<{ id: string }> = { type: 'object', properties: { id: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['id'], additionalProperties: false };
export const textSchema: JSONSchemaType<{ value: string }> = { type: 'object', properties: { value: { type: 'string', maxLength: 1000000 } }, required: ['value'], additionalProperties: false };
export const boolSchema: JSONSchemaType<{ value: boolean }> = { type: 'object', properties: { value: { type: 'boolean' } }, required: ['value'], additionalProperties: false };

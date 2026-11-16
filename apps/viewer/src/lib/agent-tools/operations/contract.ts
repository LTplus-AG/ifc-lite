/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import Ajv, { type JSONSchemaType } from 'ajv';
import type { ReadyModel, ToolCallContext } from '../types';

export type Effect = 'read' | 'view' | 'selection' | 'configuration' | 'model' | 'artifact' | 'network' | 'publication';
export interface OperationContext extends ToolCallContext { model: ReadyModel; progress?: (detail: { phase: string; done: number; total: number }) => void }
export interface Operation {
  id: string;
  version: 1;
  owner: string;
  description: string;
  effects: readonly Effect[];
  capability: 'read' | 'commands-and-edits';
  inputSchema: Record<string, unknown>;
  result: 'value';
  completion?: 'dispatched';
  implementation: 'sdk' | 'native-store';
  validate(input: unknown): void;
  execute(input: unknown, context: OperationContext): Promise<unknown>;
}

const ajv = new Ajv({ strict: true, allErrors: false });

/** One closed schema and one explicit handler. No method-path traversal. */
export function operation<T>(
  metadata: Omit<Operation, 'version' | 'inputSchema' | 'validate' | 'execute' | 'result'>,
  schema: JSONSchemaType<T>,
  handler: (input: T, context: OperationContext) => unknown | Promise<unknown>,
): Operation {
  if (metadata.effects.length === 0) throw new Error(`Missing effect policy: ${metadata.id}`);
  const validate = ajv.compile(schema);
  return { ...metadata, version: 1, result: 'value', inputSchema: schema,
    validate(input) {
      if (!validate(input)) throw new Error(`Invalid ${metadata.id} input: ${ajv.errorsText(validate.errors)}`);
    },
    async execute(input, context) {
      if (!validate(input)) throw new Error(`Invalid ${metadata.id} input: ${ajv.errorsText(validate.errors)}`);
      return handler(input, context);
    },
  };
}

export const emptySchema: JSONSchemaType<Record<string, never>> = { type: 'object', properties: {}, required: [], additionalProperties: false };
export const pointSchema: JSONSchemaType<[number, number, number]> = {
  type: 'array', items: [{ type: 'number' }, { type: 'number' }, { type: 'number' }], minItems: 3, maxItems: 3,
};
export const referenceSchema: JSONSchemaType<{ express_ids: number[] }> = {
  type: 'object', properties: { express_ids: { type: 'array', items: { type: 'integer', minimum: 1 }, maxItems: 1000 } },
  required: ['express_ids'], additionalProperties: false,
};

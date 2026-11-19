/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { nativeResultSchema } from './native-results';
import type { FeatureId } from '@/lib/features';
import type { JSONSchemaType } from 'ajv';
import { operationValidators } from './validators';
import type { OperationArtifacts } from './artifacts';
import type { ReadyModel, ToolCallContext, ToolHost } from '../types';

export type Effect = 'read' | 'view' | 'selection' | 'configuration' | 'model' | 'artifact' | 'network' | 'publication';
export interface ViewerOperationContext extends ToolCallContext {
  host: ToolHost;
  commit<T>(write: () => T): T;
  /** Authorizes native durable-write admission; an admitted write is not rolled back by late cancellation. */
  commitAsync<T>(write: () => Promise<T>, didCommit?: (result: T) => boolean): Promise<T>;
  artifacts: OperationArtifacts;
  /** Run the operation's own geometry write, such as the remesh a Room preparation needs before it reads. Afterwards
   * the executor compares later state with the model entry that write produced, but only when the entry changed in
   * its geometry alone and no edit moved the revision; any other change still refuses the operation. A geometry change
   * by someone else inside `work` cannot be told apart, so the operation must validate the geometry it read (Room
   * preparation does, through its geometry lease). A value the closing check refuses is passed to `release`. */
  ownGeometry<T>(work: () => Promise<T>, release?: (value: T) => void): Promise<T>;
  progress?: (detail: { phase: string; done: number; total: number }) => void;
}
export interface OperationContext extends ViewerOperationContext { model: ReadyModel }
export type OperationExecutionContext = ViewerOperationContext & { model?: ReadyModel };
export interface Operation {
  id: string;
  version: 1;
  owner: string;
  features?: readonly FeatureId[];
  description: string;
  needs: 'model' | 'viewer';
  effects: readonly Effect[];
  capability: 'read' | 'commands-and-edits';
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  policy?: { model?: 'native-reviewed'; artifact?: 'native-export'; network?: 'native-provider'; publication?: 'native-reviewed' };
  synchronous?: boolean;
  result: 'value';
  completion?: 'dispatched';
  implementation: 'sdk' | 'native-store';
  validate(input: unknown): void;
  validateResult(result: unknown): void;
  execute(input: unknown, context: OperationExecutionContext): Promise<unknown>;
}
type Metadata = Omit<Operation, 'version' | 'inputSchema' | 'validate' | 'execute' | 'result' | 'validateResult' | 'needs'>;

function define<T>(metadata: Metadata, needs: Operation['needs'], schema: JSONSchemaType<T>, handler: (input: T, context: OperationExecutionContext) => unknown | Promise<unknown>): Operation {
  if (metadata.effects.length === 0) throw new Error(`Missing effect policy: ${metadata.id}`);
  const writes = metadata.effects.some(effect => effect !== 'read');
  if ((writes ? 'commands-and-edits' : 'read') !== metadata.capability) throw new Error(`Inconsistent effect permission: ${metadata.id}`);
  const outputSchema = metadata.outputSchema ?? nativeResultSchema(metadata.id);
  const validators = operationValidators(metadata.id, schema, outputSchema);
  return { ...metadata, needs, version: 1, result: 'value', inputSchema: schema, outputSchema,
    ...validators,
    async execute(input, context) {
      validators.validate(input);
      const validated = input as T;
      return metadata.synchronous && writes ? context.commit(() => handler(validated, context)) : handler(validated, context);
    },
  };
}
/** One validated contract around the native model service, with an explicit target. */
export function operation<T>(metadata: Metadata, schema: JSONSchemaType<T>, handler: (input: T, context: OperationContext) => unknown | Promise<unknown>): Operation {
  return define(metadata, 'model', schema, (input, context) => {
    if (!context.model) throw new Error(`Operation ${metadata.id} requires an explicit ready model.`);
    return handler(input, { ...context, model: context.model });
  });
}
/** Viewer/session operations must also work before an IFC model is loaded. */
export function viewerOperation<T>(metadata: Metadata, schema: JSONSchemaType<T>, handler: (input: T, context: ViewerOperationContext) => unknown | Promise<unknown>): Operation {
  return define(metadata, 'viewer', schema, handler);
}
export const emptySchema: JSONSchemaType<Record<string, never>> = { type: 'object', properties: {}, required: [], additionalProperties: false };
export const pointSchema: JSONSchemaType<[number, number, number]> = {
  type: 'array', items: [{ type: 'number', minimum: -1e9, maximum: 1e9 }, { type: 'number', minimum: -1e9, maximum: 1e9 }, { type: 'number', minimum: -1e9, maximum: 1e9 }], minItems: 3, maxItems: 3,
};
export const referenceSchema: JSONSchemaType<{ express_ids: number[] }> = {
  type: 'object', properties: { express_ids: { type: 'array', items: { type: 'integer', minimum: 1 }, maxItems: 1000 } }, required: ['express_ids'], additionalProperties: false,
};

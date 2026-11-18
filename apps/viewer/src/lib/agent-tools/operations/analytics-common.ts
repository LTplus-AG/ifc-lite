/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ViewerOperationContext, Effect } from './contract';
export const idSchema = { type: 'object' as const, properties: { id: { type: 'string' as const, minLength: 1, maxLength: 200 } }, required: ['id' as const], additionalProperties: false as const };
export const jsonSchema = { type: 'object' as const, properties: { content_json: { type: 'string' as const, minLength: 2, maxLength: 500_000 } }, required: ['content_json' as const], additionalProperties: false as const };
export const artifactSchema = { type: 'object', properties: { artifact_id: { type: 'string' }, filename: { type: 'string' }, mime_type: { type: 'string' }, bytes: { type: 'integer', minimum: 0 } }, required: ['artifact_id', 'filename', 'mime_type', 'bytes'], additionalProperties: false };
export function metadata(id: string, owner: string, description: string, effects: readonly Effect[], outputSchema: Record<string, unknown>) {
  return { id, owner, description, effects, outputSchema,
    capability: effects.every(effect => effect === 'read') ? 'read' as const : 'commands-and-edits' as const,
    implementation: 'native-store' as const,
    ...(effects.includes('artifact') ? { policy: { artifact: 'native-export' as const } } : {}),
  };
}
export function checkpoint(c: ViewerOperationContext) { c.signal?.throwIfAborted(); c.checkpoint?.(); }
export const removedSchema = { type: 'object', properties: { removed: { type: 'string' } }, required: ['removed'], additionalProperties: false };

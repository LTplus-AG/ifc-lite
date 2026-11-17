/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { JSONSchemaType } from 'ajv';
import { mainViewerToolDefinitions } from '../main-viewer-tool-definitions';
import { mainViewerTool } from '../main-viewer-dispatch';
import { operation, viewerOperation, type OperationContext, type ViewerOperationContext } from './contract';

/** Inputs and implementations come from the native viewer tools, not a second query vocabulary. */
const queries = [
  ['model_info', 'model.inspect', 'properties'], ['model_list', 'models.list', 'sources'],
  ['schema_describe', 'schema.describe', 'properties'], ['query_entities', 'entities.query', 'hierarchy'],
  ['count_entities', 'entities.count', 'lists'], ['get_entity', 'entity.inspect', 'properties'],
  ['get_entities_bulk', 'entities.inspect', 'properties'], ['spatial_hierarchy', 'hierarchy.tree', 'hierarchy'],
  ['containment_chain', 'entity.containment', 'hierarchy'], ['relationships', 'entity.relationships', 'properties'],
  ['properties_unique', 'properties.unique', 'properties'], ['materials_list', 'materials.list', 'properties'],
  ['classifications_list', 'classifications.list', 'properties'], ['georeferencing', 'georeferencing.read', 'placement'],
  ['units', 'units.read', 'properties'], ['model_audit', 'model.audit', 'validation'],
  ['geometry_bbox', 'geometry.bounds', 'properties'], ['geometry_volume', 'geometry.volume', 'properties'],
  ['geometry_area', 'geometry.area', 'properties'],
] as const;
const definitions = new Map(mainViewerToolDefinitions().map(definition => [definition.name, definition]));
const outputSchema = { type: 'object', properties: { native_json: { type: 'string' }, text: { type: 'string' } }, required: ['native_json', 'text'], additionalProperties: false };
export const queryOperations = queries.map(([toolId, id, owner]) => {
  const definition = definitions.get(toolId), tool = mainViewerTool(toolId);
  if (!definition || !tool || !definition.readOnly) throw new Error(`Missing native read contract: ${toolId}`);
  const { model_id: _target, ...properties } = definition.inputSchema.properties;
  // The canonical tool catalogue is runtime JSON Schema, not generated TypeScript.
  const schema = { ...definition.inputSchema, properties, required: definition.inputSchema.required?.filter(key => key !== 'model_id') ?? [], additionalProperties: false } as unknown as JSONSchemaType<Record<string, unknown>>;
  const metadata = { id, owner, description: definition.description, effects: ['read'] as const, capability: 'read' as const, implementation: 'sdk' as const, outputSchema };
  const wire = (result: Awaited<ReturnType<typeof tool.run>>) => ({ native_json: JSON.stringify(result.structured ?? null), text: result.text });
  if (tool.needs === 'none') return viewerOperation(metadata, schema, async (input, context: ViewerOperationContext) => wire(await tool.run(context.host, input, context)));
  return operation(metadata, schema, async (input, context: OperationContext) => wire(await tool.run(context.host, context.model, input, context)));
});

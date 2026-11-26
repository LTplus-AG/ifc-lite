/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The tool list the main viewer advertises to a connecting agent (#9523),
 * derived from the same catalog as the stdio MCP server and the playground,
 * narrowed to the allowlist and adjusted where the viewer's contract differs
 * (every model tool takes `model_id`; IDS arrives inline).
 */

import { VIEWER_COMMAND_SPECS } from './viewer-command-tools.js';
import { CATALOG } from '@/components/mcp/data';
import { createAnthropicToolDefinitions, type AnthropicInputSchema } from '@/components/mcp/playground-tool-definitions';
import { MAIN_VIEWER_EDIT_TOOLS, MAIN_VIEWER_TOOL_ALLOWLIST, mainViewerTool } from './main-viewer-dispatch.js';
import { EDIT_TOOL_SPECS } from './edit-tools.js';
import type { AgentInputSchema } from './types.js';

export interface AgentToolDefinition {
  name: string;
  description: string;
  /** JSON Schema of the arguments (`type: 'object'`). */
  inputSchema: AgentInputSchema | AnthropicInputSchema;
  /** False for edits and command execution, which the bridge hides and refuses while the tab grants read-only. */
  readOnly: boolean;
}

const MODEL_ID_PROPERTY = {
  type: 'string',
  description: 'Id of the model, from model_list. Optional when exactly one model is loaded.',
};

const IDS_XML_PROPERTY = {
  type: 'string',
  description: 'The IDS document as XML text. File paths cannot be read from the viewer.',
};

const IDS_DESCRIPTIONS: Record<string, string> = {
  ids_validate: 'Run a buildingSMART IDS spec, passed inline as ids_xml, against a model open in the viewer, including its unsaved edits. Per-spec pass/fail with offending entities.',
  ids_explain: 'Parse and summarize an IDS document, passed inline as ids_xml, in plain language: what each spec asks for, in what order.',
};

function withModelId<S extends AgentInputSchema | AnthropicInputSchema>(schema: S): S {
  if (schema.properties.model_id) return schema;
  return { ...schema, properties: { ...schema.properties, model_id: MODEL_ID_PROPERTY } } as S;
}

function withInlineIds(schema: AnthropicInputSchema): AnthropicInputSchema {
  const { ids_path: _path, ...properties } = schema.properties;
  const required = (schema.required ?? []).filter((name) => name !== 'ids_path');
  return { type: 'object', properties: { ...properties, ids_xml: IDS_XML_PROPERTY }, required: [...required, 'ids_xml'] };
}

/**
 * Name, description, argument schema and read-only flag of every tool the main
 * viewer serves: the reads, then the edits (`readOnly: false`). The list is the
 * same whatever the user granted; the grant travels as the hello's or
 * update's `permission`, and the tab refuses edits itself while read-only.
 */
export function mainViewerToolDefinitions(): AgentToolDefinition[] {
  const scopes = new Map(CATALOG.tools.map((tool) => [tool.name, tool.scope]));
  const edits = MAIN_VIEWER_EDIT_TOOLS.map((name): AgentToolDefinition => ({
    name,
    description: EDIT_TOOL_SPECS[name].description,
    inputSchema: withModelId(EDIT_TOOL_SPECS[name].inputSchema),
    readOnly: false,
  }));
  return [...readDefinitions(scopes), ...edits, ...Object.entries(VIEWER_COMMAND_SPECS).map(([name, spec]) => ({ name, ...spec }))];
}

// These browser handlers use resolveRef, which accepts either identifier.
const ENTITY_REFERENCE_TOOLS = new Set([
  'get_entity', 'containment_chain', 'relationships', 'geometry_bbox', 'geometry_volume', 'geometry_area',
]);

function readDefinitions(scopes: Map<string, string>): AgentToolDefinition[] {
  // A tool this page does not serve (`mainViewerTool`, e.g. bSDD with outside services off) is not offered.
  const served = MAIN_VIEWER_TOOL_ALLOWLIST.filter((name) => mainViewerTool(name) !== undefined);
  return createAnthropicToolDefinitions(served).map((definition) => {
    const tool = mainViewerTool(definition.name);
    let schema = definition.input_schema;
    if (ENTITY_REFERENCE_TOOLS.has(definition.name)) {
      schema = {
        ...schema,
        properties: {
          ...schema.properties,
          global_id: { type: 'string', description: 'IFC GlobalId. Supply this or express_id.' },
          express_id: { type: 'integer', minimum: 1, description: 'STEP entity id. Supply this or global_id.' },
        },
        required: schema.required?.filter((name) => name !== 'global_id'),
      };
    }
    if (tool && tool.needs !== 'none') schema = withModelId(schema);
    if (definition.name in IDS_DESCRIPTIONS) schema = withInlineIds(schema);
    return {
      name: definition.name,
      description: IDS_DESCRIPTIONS[definition.name] ?? definition.description,
      inputSchema: schema,
      readOnly: scopes.get(definition.name) === 'read',
    };
  });
}

let schemas: Map<string, AgentToolDefinition['inputSchema']> | undefined;

/**
 * The argument schema the viewer advertises for `name`, so dispatch enforces
 * exactly what the agent was shown. Refresh on a miss for newly enabled tools.
 * Dispatch checks availability before consulting the cache.
 */
export function mainViewerInputSchema(name: string): AgentToolDefinition['inputSchema'] | undefined {
  if (!schemas?.has(name)) {
    schemas = new Map(mainViewerToolDefinitions().map(({ name, inputSchema }) => [name, inputSchema]));
  }
  return schemas.get(name);
}

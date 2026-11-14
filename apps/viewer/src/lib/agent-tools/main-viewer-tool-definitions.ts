/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The tool list the main viewer advertises to a connecting agent (#9523),
 * derived from the same catalog as the stdio MCP server and the playground,
 * narrowed to the allowlist and adjusted where the viewer's contract differs
 * (every model tool takes `model_id`; IDS arrives inline).
 */

import { CATALOG } from '@/components/mcp/data';
import { createAnthropicToolDefinitions, type AnthropicInputSchema } from '@/components/mcp/playground-tool-definitions';
import { MAIN_VIEWER_TOOL_ALLOWLIST, mainViewerTool } from './main-viewer-dispatch.js';

export interface AgentToolDefinition {
  name: string;
  description: string;
  /** JSON Schema of the arguments (`type: 'object'`). */
  inputSchema: AnthropicInputSchema;
  /** True for every tool here: the viewer serves no tool that changes the model. */
  readOnly: boolean;
}

const MODEL_ID_PROPERTY = {
  type: 'string',
  description: 'Id of the model to read, from model_list. Optional when exactly one model is loaded.',
};

const IDS_XML_PROPERTY = {
  type: 'string',
  description: 'The IDS document as XML text. File paths cannot be read from the viewer.',
};

const IDS_DESCRIPTIONS: Record<string, string> = {
  ids_validate: 'Run a buildingSMART IDS spec, passed inline as ids_xml, against a model open in the viewer, including its unsaved edits. Per-spec pass/fail with offending entities.',
  ids_explain: 'Parse and summarize an IDS document, passed inline as ids_xml, in plain language: what each spec asks for, in what order.',
};

function withModelId(schema: AnthropicInputSchema): AnthropicInputSchema {
  if (schema.properties.model_id) return schema;
  return { ...schema, properties: { ...schema.properties, model_id: MODEL_ID_PROPERTY } };
}

function withInlineIds(schema: AnthropicInputSchema): AnthropicInputSchema {
  const { ids_path: _path, ...properties } = schema.properties;
  const required = (schema.required ?? []).filter((name) => name !== 'ids_path');
  return { type: 'object', properties: { ...properties, ids_xml: IDS_XML_PROPERTY }, required: [...required, 'ids_xml'] };
}

/** Name, description, argument schema and read-only flag of every tool the main viewer serves. */
export function mainViewerToolDefinitions(): AgentToolDefinition[] {
  const scopes = new Map(CATALOG.tools.map((tool) => [tool.name, tool.scope]));
  // A tool this page does not serve (`mainViewerTool`, e.g. bSDD with outside services off) is not offered.
  const served = MAIN_VIEWER_TOOL_ALLOWLIST.filter((name) => mainViewerTool(name) !== undefined);
  return createAnthropicToolDefinitions(served).map((definition) => {
    const tool = mainViewerTool(definition.name);
    let schema = definition.input_schema;
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

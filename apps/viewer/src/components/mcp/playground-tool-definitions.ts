/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { CATALOG, paramsFor } from './data';
import type { CatalogTool } from './types';

/** Anthropic-compatible JSON schema for a single tool's input. */
export interface AnthropicInputSchema {
  type: 'object';
  properties: Record<string, {
    type: string;
    description?: string;
    enum?: unknown[];
    minimum?: number;
    maximum?: number;
  }>;
  required?: string[];
}

export interface AnthropicToolDef {
  name: string;
  description: string;
  input_schema: AnthropicInputSchema;
}

/**
 * Descriptions that are true of the stdio MCP server but not of the browser
 * playground, overridden for the agent only (#2471).
 */
const PLAYGROUND_DESCRIPTION_OVERRIDES: Record<string, string> = {
  model_load:
    'NOT AVAILABLE HERE. The browser playground holds exactly one model and cannot federate. ' +
    'Ask the user to load a different file instead. (The stdio MCP server does support this.)',
};

/** Build the `tools` array Anthropic expects from the shared catalog. */
export function createAnthropicToolDefinitions(supportedToolNames: readonly string[]): AnthropicToolDef[] {
  const supported = new Set(supportedToolNames);
  return CATALOG.tools
    .filter((tool: CatalogTool) => supported.has(tool.name))
    .map((tool) => ({
      name: tool.name,
      description: PLAYGROUND_DESCRIPTION_OVERRIDES[tool.name] ?? tool.description,
      input_schema: ensureObjectSchema(tool),
    }));
}

/** Anthropic requires input_schema.type === 'object'. */
function ensureObjectSchema(tool: CatalogTool): AnthropicInputSchema {
  const raw = tool.inputSchema as {
    type?: string;
    properties?: Record<string, {
      type?: string;
      description?: string;
      enum?: unknown[];
      minimum?: number;
      maximum?: number;
    }>;
    required?: string[];
  } | undefined;
  if (raw?.type === 'object' && raw.properties && Object.keys(raw.properties).length > 0) {
    const properties: AnthropicInputSchema['properties'] = {};
    for (const [name, property] of Object.entries(raw.properties)) {
      properties[name] = {
        type: typeof property?.type === 'string' ? property.type : 'string',
        ...(property?.description ? { description: property.description } : {}),
        ...(Array.isArray(property?.enum) ? { enum: property.enum } : {}),
        ...(typeof property?.minimum === 'number' ? { minimum: property.minimum } : {}),
        ...(typeof property?.maximum === 'number' ? { maximum: property.maximum } : {}),
      };
    }
    return {
      type: 'object',
      properties,
      ...(Array.isArray(raw.required) && raw.required.length > 0 ? { required: raw.required } : {}),
    };
  }

  const properties: AnthropicInputSchema['properties'] = {};
  const required: string[] = [];
  for (const parameter of paramsFor(tool)) {
    properties[parameter.name] = {
      type: jsonSchemaType(parameter.type),
      ...(parameter.description ? { description: parameter.description } : {}),
    };
    if (parameter.required) required.push(parameter.name);
  }
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) };
}

function jsonSchemaType(type: string): string {
  if (type.startsWith('integer')) return 'integer';
  if (type.startsWith('number')) return 'number';
  if (type.startsWith('boolean')) return 'boolean';
  if (type.endsWith('[]') || type.startsWith('Array<')) return 'array';
  if (type.startsWith('{') || type.startsWith('object')) return 'object';
  return 'string';
}

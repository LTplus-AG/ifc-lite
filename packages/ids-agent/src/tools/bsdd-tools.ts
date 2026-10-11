/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * bSDD tools (`05-bsdd.md` §3), over the host's `BsddClient`. Registered only
 * when a client is provided. Only search terms and URIs leave the agent;
 * nothing from the document or the model is sent to the dictionary.
 */

import { capText, clampLimit, objectSchema, type AgentToolContext, type IdsAgentTool } from './context.js';
import { defineTool, failure, success } from './registry.js';

function client(ctx: AgentToolContext) {
  if (!ctx.bsdd) throw new Error('bSDD is not available.');
  return ctx.bsdd;
}

const URI = { type: 'string', minLength: 1, pattern: '^https?://' } as const;

const search = defineTool<{ text: string; dictionaryUri?: string; relatedIfcEntity?: string; limit?: number }, AgentToolContext>({
  name: 'bsdd_search', group: 'bsdd', strict: true, readOnly: true,
  description: 'Search buildingSMART Data Dictionary classes by text, optionally within one dictionary or related to an IFC entity. Returns class URIs and codes to use as classification values.',
  inputSchema: objectSchema({
    text: { type: 'string', minLength: 1 }, dictionaryUri: URI, relatedIfcEntity: { type: 'string' },
    limit: { type: 'integer', minimum: 1, description: 'At most 20.' },
  }, ['text']),
  async run(input, ctx) {
    const results = await client(ctx).search({ ...input, limit: clampLimit(input.limit, 10, 20) }, ctx.signal);
    return success(`${results.length} bSDD classes for "${input.text}"`, { results: results.slice(0, 20) });
  },
});

const classCard = defineTool<{ uri: string }, AgentToolContext>({
  name: 'bsdd_class', group: 'bsdd', strict: true, readOnly: true,
  description: 'The card of one bSDD class by URI: code, name, dictionary, definition and related IFC entities.',
  inputSchema: objectSchema({ uri: URI }, ['uri']),
  async run(input, ctx) {
    const card = await client(ctx).getClass(input.uri, ctx.signal);
    if (!card) return failure('unknown bSDD class', { error: `No bSDD class at ${input.uri}.` }, [`BSDD:${input.uri}`]);
    return success(`bSDD class ${card.code}`, { ...card, ...(card.definition ? { definition: capText(card.definition, 500) } : {}) });
  },
});

const properties = defineTool<{ uri: string }, AgentToolContext>({
  name: 'bsdd_properties', group: 'bsdd', strict: true, readOnly: true,
  description: 'The properties a bSDD class defines: code, name, property set, data type, units and allowed values.',
  inputSchema: objectSchema({ uri: URI }, ['uri']),
  async run(input, ctx) {
    const props = await client(ctx).classProperties(input.uri, ctx.signal);
    return success(`${props.length} bSDD properties`, {
      properties: props.slice(0, 60).map((p) => ({ ...p, ...(p.allowedValues ? { allowedValues: p.allowedValues.slice(0, 40) } : {}),
        ...(p.definition ? { definition: capText(p.definition, 200) } : {}) })),
    });
  },
});

const resolveUri = defineTool<{ uri: string }, AgentToolContext>({
  name: 'bsdd_resolve_uri', group: 'bsdd', strict: true, readOnly: true,
  description: 'Resolve a bSDD URI (class, property or dictionary) to what it identifies.',
  inputSchema: objectSchema({ uri: URI }, ['uri']),
  async run(input, ctx) {
    const resolution = await client(ctx).resolveUri(input.uri, ctx.signal);
    if (resolution.kind === 'unknown') return failure('unknown URI', { error: `${input.uri} does not resolve in bSDD.` }, [`BSDD:${input.uri}`]);
    return success(`bSDD ${resolution.kind}`, { ...resolution });
  },
});

export const BSDD_TOOLS: readonly IdsAgentTool[] = [search, classCard, properties, resolveUri];

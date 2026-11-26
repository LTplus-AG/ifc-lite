/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Every tool in the default registry describes itself: a title, all four
 * annotation hints, schemas that a standard JSON Schema 2020-12 validator
 * (ajv) accepts in strict mode, and only keywords our own validator enforces.
 * `tools/list` stays under a byte budget that only moves down.
 */

import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { fullScope } from '../auth/scope.js';
import { InMemoryModelRegistry } from '../context.js';
import { PromptRegistry } from '../prompts/index.js';
import type { JsonSchema, ToolDefinition } from '../protocol/index.js';
import { ResourceRegistry } from '../resources/index.js';
import { MCPServer } from '../server.js';
import { InProcessTransport } from '../transport/in-process.js';
import { ENFORCED_KEYWORDS } from '../validate.js';
import { buildDefaultToolRegistry } from './index.js';

/**
 * Bytes of the full-scope `tools/list` result. Lower it when the catalog
 * shrinks; raising it needs a reason in the commit message. Was ~143 KB (without
 * titles or annotations) before
 * the ids_apply_ops op schema moved to a resource.
 */
const TOOLS_LIST_BUDGET = 126_500;

/** Scope `read`/`validate` tools that still change session state outside the model. */
const NOT_READ_ONLY_IN_READ_SCOPE = new Set([
  // Viewer display state: colours, visibility, camera, section, selection.
  'viewer_open', 'viewer_close', 'viewer_colorize', 'viewer_isolate', 'viewer_hide', 'viewer_show', 'viewer_reset',
  'viewer_fly_to', 'viewer_set_section', 'viewer_clear_section', 'viewer_color_by_storey', 'viewer_color_by_property',
  'viewer_select', 'a2ui_viewer_action',
  // Writes a durable pending Flow artifact.
  'propose_flow',
]);

const tools = buildDefaultToolRegistry().list();

async function listTools(): Promise<{ tools: ToolDefinition[]; bytes: number }> {
  const server = new MCPServer({
    version: 'test', registry: new InMemoryModelRegistry(), tools: buildDefaultToolRegistry(),
    resources: new ResourceRegistry(), prompts: new PromptRegistry(), scope: fullScope(),
  });
  const transport = new InProcessTransport();
  await transport.connect(server);
  await transport.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'catalog', version: 'test' } } });
  const res = (await transport.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })) as { result: { tools: ToolDefinition[] } };
  return { tools: res.result.tools, bytes: Buffer.byteLength(JSON.stringify(res.result)) };
}

/** Keywords used anywhere in a schema; names under `properties` / `$defs` are not keywords. */
function keywords(schema: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(schema)) schema.forEach((s) => keywords(s, out));
  else if (schema !== null && typeof schema === 'object') {
    for (const [key, value] of Object.entries(schema)) {
      out.add(key);
      if (key === 'properties' || key === '$defs') Object.values(value as object).forEach((s) => keywords(s, out));
      else if (key !== 'enum' && key !== 'const' && key !== 'default' && key !== 'examples') keywords(value, out);
    }
  }
  return out;
}

function ajv() {
  return new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true, strictRequired: false });
}

describe('tool catalog', () => {
  it.each(tools.map((t) => [t.name, t] as const))('%s has a title and every annotation hint', (_name, tool) => {
    expect(tool.title?.trim()).toBeTruthy();
    const a = tool.annotations ?? {};
    for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) {
      expect(typeof a[hint], `${tool.name}.${hint}`).toBe('boolean');
    }
  });

  it('annotations agree with scope', () => {
    const wrong = tools.filter((t) => {
      const readOnly = t.annotations?.readOnlyHint === true;
      if (t.scope === 'mutate' || t.scope === 'export') return readOnly;
      if (t.scope === 'read' || t.scope === 'validate') return readOnly === NOT_READ_ONLY_IN_READ_SCOPE.has(t.name);
      return false;
    });
    expect(wrong.map((t) => `${t.name} (${t.scope})`)).toEqual([]);
  });

  it('every schema keyword is one validateInput enforces or may ignore', () => {
    const unknown = tools.flatMap((t) => [...keywords(t.inputSchema)].filter((k) => !ENFORCED_KEYWORDS.has(k)).map((k) => `${t.name}: ${k}`));
    expect(unknown).toEqual([]);
  });

  it.each(tools.map((t) => [t.name, t] as const))('%s schemas compile under ajv 2020-12 strict mode', (_name, tool) => {
    expect(() => ajv().compile(tool.inputSchema as object)).not.toThrow();
    if (tool.outputSchema) expect(() => ajv().compile(tool.outputSchema as JsonSchema as object)).not.toThrow();
  });

  it('tools/list fits the byte budget', async () => {
    const { tools: listed, bytes } = await listTools();
    expect(listed).toHaveLength(tools.length);
    expect(bytes).toBeLessThanOrEqual(TOOLS_LIST_BUDGET);
  });
});

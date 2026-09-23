/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5192: `entity_set_property`, `entity_delete_property`, `entity_set_attribute`
 * and `entity_delete` each accept `global_id` OR `express_id`, but only
 * `resolveExpressId` (inside the handler) enforced that. `entity_delete` had
 * no `required` array at all, so `entity_delete({ model_id: 'm1' })` validated
 * cleanly and failed only at runtime.
 *
 * The first block runs `validateInput` against each tool's real
 * `inputSchema`, the call `server.ts` makes before a handler runs (and that
 * `mutation_batch` repeats per sub-op). The second drives the real server
 * over the in-process transport: the call is refused as `INVALID_INPUT`
 * before any model is touched, and `tools/list` publishes no root-level
 * combinator, which the Anthropic Messages API rejects with a 400 for the
 * whole request.
 */

import { describe, expect, it } from 'vitest';
import { validateInput } from '../validate.js';
import { mutationTools } from './mutate.js';
import {
  MCPServer,
  PROTOCOL_VERSION,
  InMemoryModelRegistry,
  InProcessTransport,
  PromptRegistry,
  ResourceRegistry,
  buildDefaultToolRegistry,
  fullScope,
} from '../index.js';
import type { JsonSchema } from '../protocol/index.js';

function schemaOf(name: string) {
  const found = mutationTools.find((t) => t.name === name);
  if (!found) throw new Error(`${name} not registered`);
  return found.inputSchema;
}

const cases: Array<{ name: string; validExtra: Record<string, unknown> }> = [
  { name: 'entity_set_property', validExtra: { pset: 'Pset_WallCommon', name: 'Reference', value: 'W-01' } },
  { name: 'entity_delete_property', validExtra: { pset: 'Pset_WallCommon', name: 'Reference' } },
  { name: 'entity_set_attribute', validExtra: { attribute: 'Name', value: 'New name' } },
  { name: 'entity_delete', validExtra: {} },
];

describe('mutate tool schemas require global_id or express_id (#5192)', () => {
  for (const { name, validExtra } of cases) {
    describe(name, () => {
      it('rejects a call with neither global_id nor express_id at validation time', () => {
        const r = validateInput(schemaOf(name), { model_id: 'm1', ...validExtra });
        expect(r.valid).toBe(false);
        const msg = r.errors.map((e) => e.message).join('\n');
        expect(msg).toMatch(/anyOf/);
        // The error names both ways to fix the call.
        expect(msg).toContain('$.global_id');
        expect(msg).toContain('$.express_id');
      });

      it('accepts global_id alone', () => {
        expect(validateInput(schemaOf(name), { model_id: 'm1', global_id: 'GLOBAL00000000000000001', ...validExtra }).valid).toBe(true);
      });

      it('accepts express_id alone', () => {
        expect(validateInput(schemaOf(name), { model_id: 'm1', express_id: 70, ...validExtra }).valid).toBe(true);
      });

      it('still accepts a call supplying both global_id and express_id', () => {
        const r = validateInput(schemaOf(name), { model_id: 'm1', global_id: 'GLOBAL00000000000000001', express_id: 70, ...validExtra });
        expect(r.valid).toBe(true);
      });

      it.runIf(Object.keys(validExtra).length > 0)('still flags the tool\'s own other required fields as missing', () => {
        const r = validateInput(schemaOf(name), { model_id: 'm1', express_id: 70 });
        expect(r.valid).toBe(false);
        expect(r.errors.some((e) => e.message === 'Required property missing')).toBe(true);
      });
    });
  }
});

async function startServer() {
  const server = new MCPServer({
    version: '0.0.0-test',
    registry: new InMemoryModelRegistry(),
    scope: fullScope(),
    config: { readOnly: false, samplingEnabled: false },
    tools: buildDefaultToolRegistry(),
    resources: new ResourceRegistry(),
    prompts: new PromptRegistry(),
  });
  const transport = new InProcessTransport();
  void transport.connect(server);
  await transport.send({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'test', version: '0' } },
  });
  return transport;
}

describe('MCP server: identity rule over the wire (#5192)', () => {
  for (const { name, validExtra } of cases) {
    it(`${name} without an identity is INVALID_INPUT before the handler runs`, async () => {
      const transport = await startServer();
      const res = await transport.send({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name, arguments: validExtra },
      }) as { result: { isError: boolean; structuredContent: { code: string; details?: { errors: Array<{ message: string }> } } } };
      expect(res.result.isError).toBe(true);
      expect(res.result.structuredContent.code).toBe('INVALID_INPUT');
      // Validation, not the handler: with no model loaded the handler would
      // have answered with a model error instead.
      expect(res.result.structuredContent.details?.errors.some((e) => /anyOf/.test(e.message))).toBe(true);
    });
  }

  it('publishes no root-level anyOf/oneOf/allOf in any tool schema', async () => {
    const transport = await startServer();
    const res = await transport.send({ jsonrpc: '2.0', id: 3, method: 'tools/list' }) as {
      result: { tools: Array<{ name: string; inputSchema: JsonSchema }> };
    };
    expect(res.result.tools.length).toBeGreaterThan(0);
    const offenders = res.result.tools
      .filter((t) => ['anyOf', 'oneOf', 'allOf'].some((k) => k in t.inputSchema))
      .map((t) => t.name);
    expect(offenders).toEqual([]);
    // The rule still reaches the agent, through the property descriptions.
    const del = res.result.tools.find((t) => t.name === 'entity_delete');
    expect(del?.inputSchema.properties?.global_id?.description).toMatch(/global_id.*express_id/);
  });
});

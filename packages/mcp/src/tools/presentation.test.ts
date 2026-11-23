/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { A2UI_MIME_TYPE, IFC_CATALOG_ID, parseRef, type CreateSurfaceMessage } from '@ifc-lite/a2ui';
import { validateIfcMessages } from '@ifc-lite/a2ui/agent';
import { InMemoryModelRegistry } from '../context.js';
import { loadIfcModel } from '../loader.js';
import { PromptRegistry } from '../prompts/types.js';
import type { CallToolResult, ListToolsResult, ReadResourceResult } from '../protocol/index.js';
import { buildDefaultResourceRegistry } from '../resources/index.js';
import { MCPServer } from '../server.js';
import { buildDefaultToolRegistry } from './index.js';

const fixture = fileURLToPath(new URL('../../../../apps/viewer/public/_fixtures/AC20-FZK-Haus.ifc', import.meta.url));
const A2UI_APP_URI = 'ui://ifc-lite/a2ui-surface';
const SURFACE_ACTION_TOOL = 'a2ui_viewer_action';
const modelId = 'fixture:haus';
const registry = new InMemoryModelRegistry();
const server = new MCPServer({
  registry, version: 'test', resources: buildDefaultResourceRegistry(),
  prompts: new PromptRegistry(), tools: buildDefaultToolRegistry(),
});
let id = 0;
async function request<T>(method: string, params: unknown = {}): Promise<T> {
  const response = await server.handleMessage({ jsonrpc: '2.0', id: ++id, method, params });
  if (!response || !('result' in response)) throw new Error(JSON.stringify(response));
  return response.result as T;
}
const call = (name: string, args: Record<string, unknown>) => request<CallToolResult>('tools/call', { name, arguments: args });

function surface(result: CallToolResult) {
  expect(result.isError, JSON.stringify(result.content)).toBeUndefined();
  const embedded = result.content.find((c) => c.type === 'resource' && c.resource.mimeType === A2UI_MIME_TYPE);
  expect(embedded).toBeDefined();
  if (embedded?.type !== 'resource' || !embedded.resource.text) throw new Error('Missing embedded payload');
  const messages = JSON.parse(embedded.resource.text) as CreateSurfaceMessage[];
  expect(validateIfcMessages(messages)).toEqual([]);
  return messages[0].createSurface;
}

beforeAll(async () => {
  server.attach({ send() {} });
  registry.add(await loadIfcModel(fixture, { modelId }));
  registry.add(await loadIfcModel(fixture, { modelId: 'other' }));
  await request('initialize', {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  });
}, 20_000);
afterAll(() => server.detach());

describe('A2UI presentation through MCP', () => {
  it('projects fixture rows and groups with an independent count and explicit model-qualified refs', async () => {
    const count = await call('count_entities', { model_id: modelId, type: 'IfcWall' });
    const result = surface(await call('present_query', {
      modelId, query: { types: ['IfcWall'] }, columns: [{ path: 'Name' }, { path: 'type' }], groupBy: 'type',
    }));
    const {
      s0: stats, s1: table, s2: chart, s3: actions,
    } = result.dataModel as {
      s0: { v0: number; v1: number }; s1: { rows: { ref: string }[] };
      s2: { data: { value: number }[] }; s3: { refs: string[] };
    };
    expect(stats.v0).toBe(count.structuredContent?.total);
    expect(stats.v0).toBeGreaterThan(0);
    expect(table.rows).toHaveLength(stats.v0);
    expect(chart.data.reduce((sum, group) => sum + group.value, 0)).toBe(stats.v0);
    expect(actions.refs).toEqual(table.rows.map((row) => row.ref));
    expect(table.rows.every((row) => parseRef(row.ref)?.modelId === modelId)).toBe(true);
  });

  it('applies declarative conditions, and keeps the whole-match count when limiting rows', async () => {
    const result = surface(await call('present_query', {
      query: { modelId, types: ['IfcWall'], limit: 1, where: [{ path: 'Name', op: 'exists' }] },
      columns: [{ path: 'Name' }], groupBy: 'type',
    }));
    // Every fixture wall has a Name, so the whole-match count is the wall count.
    const count = await call('count_entities', { model_id: modelId, type: 'IfcWall' });
    const stats = result.dataModel.s0 as { v0: number; v1: number };
    expect(stats.v1).toBe(1);
    expect(stats.v0).toBe(count.structuredContent?.total);
    expect(stats.v0).toBeGreaterThan(stats.v1);
    const { rows } = result.dataModel.s1 as { rows: { Name: string }[] };
    expect(rows).toHaveLength(1);
    expect(rows[0].Name).toBeTruthy();
  });

  it('does not filter a query without types to nothing (#11344)', async () => {
    const result = surface(await call('present_query', {
      query: { modelId, where: [{ path: 'Name', op: 'exists' }] }, columns: [{ path: 'Name' }],
    }));
    const walls = await call('count_entities', { model_id: modelId, type: 'IfcWall' });
    expect((result.dataModel.s0 as { v0: number }).v0).toBeGreaterThan(walls.structuredContent?.total as number);
  });

  it('wraps IDS failure counts and model-qualified rows from the validator', async () => {
    const args = { model_id: modelId, ids_xml: `<ids xmlns="http://standards.buildingsmart.org/IDS">
      <info><title>Wall names</title></info>
      <specifications><specification name="Wall names" ifcVersion="IFC2X3">
        <applicability><entity><name><simpleValue>IFCWALLSTANDARDCASE</simpleValue></name></entity></applicability>
        <requirements><attribute><name><simpleValue>Name</simpleValue></name>
          <value><simpleValue>Required Name</simpleValue></value></attribute></requirements>
      </specification></specifications>
    </ids>` };
    const ids = await call('ids_validate', args);
    const shown = surface(await call('present_ids_results', args));
    const expected = (ids.structuredContent?.summary as { failedEntities: number } | undefined)?.failedEntities ?? 0;
    expect(expected).toBeGreaterThan(0);
    expect(shown.dataModel.s0).toMatchObject({ v2: expected });
    const { rows } = shown.dataModel.s1 as { rows: { ref: string }[] };
    expect(rows).toHaveLength(expected);
    expect(rows.every((row) => parseRef(row.ref)?.modelId === modelId)).toBe(true);
  });

  it('compares clash counts and both displayed endpoints to the headless check', async () => {
    const args = { model_id: modelId, a: 'IfcWall*', mode: 'clearance', clearance: 1 };
    const clash = await call('clash_check', args);
    const shown = surface(await call('present_clash_results', args));
    const expected = clash.structuredContent as {
      summary: { total: number }; clashes: { a: { ref: number }; b: { ref: number } }[];
    };
    expect(expected.summary.total).toBeGreaterThan(0);
    expect(shown.dataModel.s0).toMatchObject({ v0: expected.summary.total, v1: expected.clashes.length });
    const { rows } = shown.dataModel.s1 as { rows: { refs: string[] }[] };
    expect(rows.map((row) => row.refs)).toEqual(expected.clashes.map(({ a, b }) => [
      `${modelId}:${a.ref}`, `${modelId}:${b.ref}`,
    ]));
  }, 30_000);

  it('publishes the app and catalog and reports when a viewer is absent', async () => {
    const { tools } = await request<ListToolsResult>('tools/list');
    for (const name of ['present_query', 'present_ids_results', 'present_clash_results', SURFACE_ACTION_TOOL]) {
      expect(tools.find((tool) => tool.name === name)?._meta?.ui).toEqual({
        resourceUri: A2UI_APP_URI,
        visibility: name === SURFACE_ACTION_TOOL ? ['app'] : ['model', 'app'],
      });
    }
    const { contents: [app] } = await request<ReadResourceResult>('resources/read', { uri: A2UI_APP_URI });
    expect(app.mimeType).toBe('text/html;profile=mcp-app');
    expect(app.text).toContain(IFC_CATALOG_ID);
    expect(app.text).toMatch(/<script>.+<\/script>/s);
    expect(app.text).not.toMatch(/<script\b[^>]*\bsrc\s*=|<link\b[^>]*\bhref\s*=/i);
    const { contents: [catalog] } = await request<ReadResourceResult>('resources/read', { uri: IFC_CATALOG_ID });
    expect(JSON.parse(catalog.text ?? '{}')).toHaveProperty('catalogId', IFC_CATALOG_ID);
    const result = await call(SURFACE_ACTION_TOOL, { action: 'select', refs: [`${modelId}:42`] });
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.code).toBe('VIEWER_NOT_CONNECTED');
  });

  it('selects model-aware refs over the connected viewer command stream', async () => {
    const rows = surface(await call('present_query', {
      modelId, query: { types: ['IfcWall'], limit: 1 }, columns: [{ path: 'Name' }],
    })).dataModel.s1 as { rows: { ref: string }[] };
    const [{ ref }] = rows.rows;
    const expressId = parseRef(ref)!.expressId;
    const opened = await call('viewer_open', { model_id: modelId });
    const url = opened.structuredContent?.url;
    expect(typeof url, JSON.stringify(opened)).toBe('string');
    const signal = new AbortController();
    try {
      await expect.poll(() => server.viewer.state()?.clientCount).toBe(1);
      const disconnected = await call(SURFACE_ACTION_TOOL, { action: 'select', refs: [ref] });
      expect(disconnected.structuredContent?.code).toBe('VIEWER_NOT_CONNECTED');
      const stream = await fetch(new URL('/events', String(url)), { signal: AbortSignal.any([signal.signal, AbortSignal.timeout(4000)]) });
      const reader = stream.body!.getReader();
      await reader.read();
      await expect.poll(() => server.viewer.hasConnectedClient()).toBe(true);
      const crossModel = await call(SURFACE_ACTION_TOOL, { action: 'select', refs: [`other:${expressId}`] });
      expect(crossModel.structuredContent?.code).toBe('INVALID_INPUT');
      const selected = await call(SURFACE_ACTION_TOOL, { action: 'select', refs: [ref] });
      expect(selected.structuredContent).toEqual({ count: 1 });
      const event = await reader.read();
      expect(new TextDecoder().decode(event.value)).toContain(JSON.stringify({ action: 'selectEntities', ids: [expressId] }));
      expect(server.viewer.state()?.selection).toMatchObject([{ expressId }]);
      // An empty or non-hex legend colour falls back to the default instead of failing in viewer_colorize (#11344).
      for (const color of ['', 'not-a-colour']) {
        const coloured = await call(SURFACE_ACTION_TOOL, { action: 'colorize', refs: [ref], color });
        expect(coloured.isError, JSON.stringify(coloured)).not.toBe(true);
      }
    } finally {
      signal.abort();
      await call('viewer_close', {});
    }
  });

});

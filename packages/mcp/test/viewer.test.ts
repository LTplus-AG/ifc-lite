/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Viewer integration test — boots the actual viewer HTTP server in-process,
 * drives it through MCP tool calls, fakes a user pick by POSTing
 * `{action:"picked",…}` to /api/command (the same path the browser uses),
 * and asserts:
 *   • viewer_open returns a usable URL.
 *   • viewer_colorize / viewer_isolate succeed without errors.
 *   • The selection event flows back through SSE and lands in
 *     viewer_get_selection AND emits notifications/resources/updated.
 *   • viewer_close tears the server down cleanly.
 */

import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { IfcCreator } from '@ifc-lite/create';
import {
  PROTOCOL_VERSION,
  InProcessTransport,
  InMemoryModelRegistry,
  createMCPServer,
  loadIfcModel,
  type MCPServer,
} from '../src/index.js';

let tmp: string;
let ifcPath: string;

async function call<T>(
  transport: InProcessTransport,
  id: number,
  method: string,
  params?: unknown,
): Promise<T> {
  const res = (await transport.send({ jsonrpc: '2.0', id, method, params })) as { result?: T; error?: { message: string } };
  if (res.error) throw new Error(`${method} failed: ${res.error.message}`);
  return res.result as T;
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ifc-lite-mcp-viewer-'));
  ifcPath = join(tmp, 'tiny.ifc');
  const creator = new IfcCreator({ Name: 'Viewer Test' });
  const storey = creator.addIfcBuildingStorey({ Name: 'L1', Elevation: 0 });
  creator.addIfcWall(storey, { Start: [0, 0, 0], End: [4, 0, 0], Height: 3, Thickness: 0.2 });
  creator.addIfcWall(storey, { Start: [0, 0, 0], End: [0, 4, 0], Height: 3, Thickness: 0.2 });
  await writeFile(ifcPath, creator.toIfc().content, 'utf-8');
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

interface Boot {
  server: MCPServer;
  transport: InProcessTransport;
  notifications: unknown[];
  modelId: string;
}

async function boot(): Promise<Boot> {
  const registry = new InMemoryModelRegistry();
  const loaded = await loadIfcModel(ifcPath);
  registry.add(loaded);
  const server = createMCPServer({ version: '0.0.0-test', registry });
  const transport = new InProcessTransport();
  await transport.connect(server);
  const notifications: unknown[] = [];
  transport.onMessage((m) => {
    if ((m as { id?: unknown }).id === undefined) notifications.push(m);
  });
  await call(transport, 1, 'initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'viewer-test', version: '0' },
  });
  return { server, transport, notifications, modelId: loaded.id };
}

describe('viewer tools — full integration', () => {
  it('opens, paints, isolates, captures pick, and closes', async () => {
    const { server, transport, notifications } = await boot();

    // 1. Open viewer.
    const open = await call<{ structuredContent: { url: string; port: number; modelId: string } }>(
      transport, 2, 'tools/call',
      { name: 'viewer_open', arguments: {} },
    );
    expect(open.structuredContent.url).toMatch(/^http:\/\/localhost:\d+\/$/);
    const { port } = open.structuredContent;
    expect(port).toBeGreaterThan(0);

    // 2. Status.
    const status = await call<{ structuredContent: { open: boolean; port: number } }>(
      transport, 3, 'tools/call',
      { name: 'viewer_status', arguments: {} },
    );
    expect(status.structuredContent.open).toBe(true);
    expect(status.structuredContent.port).toBe(port);

    // 3. Colorize all walls red.
    const paint = await call<{ structuredContent: { count: number } }>(
      transport, 4, 'tools/call',
      { name: 'viewer_colorize', arguments: { type: 'IfcWall', color: 'red' } },
    );
    expect(paint.structuredContent.count).toBe(2);

    // 4. Isolate to one wall via express_id.
    const isolate = await call<{ structuredContent: { count: number } }>(
      transport, 5, 'tools/call',
      { name: 'viewer_isolate', arguments: { type: 'IfcWall' } },
    );
    expect(isolate.structuredContent.count).toBe(2);

    // 5. Color by property — even when properties are missing, the legend
    //    should at least include a "missing" bucket without throwing.
    const paintByProp = await call<{ structuredContent: { legend: Array<{ value: string; count: number }> } }>(
      transport, 6, 'tools/call',
      { name: 'viewer_color_by_property', arguments: { type: 'IfcWall', pset: 'Pset_WallCommon', property: 'IsExternal' } },
    );
    expect(Array.isArray(paintByProp.structuredContent.legend)).toBe(true);

    // 6. Subscribe to viewer/selection resource so we can prove updates fire.
    await call(transport, 7, 'resources/subscribe', { uri: 'ifc-lite://viewer/selection' });

    // 7. Fake a user pick by POSTing to the viewer's REST API exactly the way
    //    the browser does. The viewer broadcasts it via SSE; the
    //    ViewerManager should pick it up and update its selection state.
    const wallId = 0; // We'll use a real expressId from the loaded model.
    const list = await call<{ structuredContent: { entities: Array<{ expressId?: number }> } }>(
      transport, 8, 'tools/call',
      { name: 'query_entities', arguments: { type: 'IfcWall', fields: ['expressId', 'globalId'] } },
    );
    const realExpressId = (list.structuredContent.entities[0] as { expressId: number }).expressId;
    expect(realExpressId).toBeGreaterThan(0);
    void wallId;

    const pickRes = await fetch(`http://localhost:${port}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'picked', expressId: realExpressId, ifcType: 'IfcWall' }),
    });
    expect(pickRes.ok).toBe(true);

    // Wait for SSE → ViewerManager to settle.
    await new Promise((r) => setTimeout(r, 200));

    // 8. The notifications we received should include a resources/updated
    //    pointing at the viewer/selection URI.
    const updates = notifications.filter((n): n is { method: string; params?: { uri?: string } } => {
      const m = n as { method?: string };
      return m.method === 'notifications/resources/updated';
    });
    expect(updates.some((u) => u.params?.uri === 'ifc-lite://viewer/selection')).toBe(true);

    // 9. viewer_get_selection now returns the picked entity.
    const sel = await call<{ structuredContent: { selection: Array<{ expressId: number; ifcType?: string }> } }>(
      transport, 9, 'tools/call',
      { name: 'viewer_get_selection', arguments: {} },
    );
    expect(sel.structuredContent.selection.length).toBe(1);
    expect(sel.structuredContent.selection[0].expressId).toBe(realExpressId);

    // 10. With include=["properties"], we get more data per pick.
    const richSel = await call<{ structuredContent: { selection: Array<{ entity?: { type: string }; properties?: unknown }> } }>(
      transport, 10, 'tools/call',
      { name: 'viewer_get_selection', arguments: { include: ['properties'] } },
    );
    expect(richSel.structuredContent.selection[0].entity?.type).toMatch(/Wall/i);

    // 11. Resource read also reports the selection state.
    const resourceRead = await call<{ contents: Array<{ text: string }> }>(
      transport, 11, 'resources/read',
      { uri: 'ifc-lite://viewer/selection' },
    );
    const payload = JSON.parse(resourceRead.contents[0].text) as { selection: Array<{ expressId: number }> };
    expect(payload.selection.length).toBe(1);
    expect(payload.selection[0].expressId).toBe(realExpressId);

    // 12. Close and confirm we get back into the closed state.
    await call(transport, 12, 'tools/call', { name: 'viewer_close', arguments: {} });
    expect(server.viewer.isOpen()).toBe(false);

    transport.close();
  }, 15_000);

  it('viewer_ask returns a structured suggestion without opening anything', async () => {
    const { transport, server } = await boot();
    const res = await call<{ structuredContent: { suggestedTool: string; suggestedArgs: { model_id: string } } }>(
      transport, 100, 'tools/call',
      { name: 'viewer_ask', arguments: { reason: 'to highlight failing doors' } },
    );
    expect(res.structuredContent.suggestedTool).toBe('viewer_open');
    expect(server.viewer.isOpen()).toBe(false);
    transport.close();
  });

  it('emits PERMISSION-friendly errors when called before viewer_open', async () => {
    const { transport } = await boot();
    const res = await call<{ structuredContent?: { code?: string }; isError?: boolean; content: Array<{ text: string }> }>(
      transport, 200, 'tools/call',
      { name: 'viewer_colorize', arguments: { type: 'IfcWall', color: 'red' } },
    );
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.code).toBe('UNSUPPORTED_OPERATION');
    transport.close();
  });
});

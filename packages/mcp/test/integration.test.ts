/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * End-to-end test that drives the MCP server with a real (tiny) IFC model.
 *
 * Uses `@ifc-lite/create` to build the IFC content in-memory, writes it to
 * a temp file, loads it via `loadIfcModel`, and exercises a representative
 * cross-section of the tool surface through the in-process transport.
 *
 * This is the closest thing to a Claude Desktop / Cursor smoke test we
 * have without a real client.
 */

import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
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
} from '../src/index.js';

let tmp: string;
let ifcPath: string;

async function send<T>(transport: InProcessTransport, id: number, method: string, params?: unknown): Promise<T> {
  const res = (await transport.send({ jsonrpc: '2.0', id, method, params })) as { result: T };
  return res.result;
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ifc-lite-mcp-test-'));
  ifcPath = join(tmp, 'tiny.ifc');
  // Build a tiny IFC4 model: project + site + building + 1 storey + 1 wall.
  const creator = new IfcCreator({ Name: 'Test Project' });
  const storeyId = creator.addIfcBuildingStorey({ Name: 'Level 1', Elevation: 0 });
  const wallId = creator.addIfcWall(storeyId, {
    Start: [0, 0, 0],
    End: [5, 0, 0],
    Height: 3,
    Thickness: 0.2,
  });
  expect(wallId).toBeGreaterThan(0);
  const result = creator.toIfc();
  await writeFile(ifcPath, result.content, 'utf-8');
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('end-to-end MCP server with real IFC', () => {
  it('loads a model and answers the headline tool calls', async () => {
    const registry = new InMemoryModelRegistry();
    const loaded = await loadIfcModel(ifcPath);
    registry.add(loaded);
    const server = createMCPServer({ version: '0.0.0-test', registry });
    const transport = new InProcessTransport();
    await transport.connect(server);

    await send(transport, 1, 'initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'integration-test', version: '0' },
    });

    // model_info should report the model we just loaded.
    const info = await send<{ structuredContent: { id: string; entityCount: number; schema: string } }>(
      transport, 2, 'tools/call',
      { name: 'model_info', arguments: {} },
    );
    expect(info.structuredContent.id).toBe(loaded.id);
    expect(info.structuredContent.entityCount).toBeGreaterThan(0);
    expect(info.structuredContent.schema).toMatch(/^IFC/);

    // query_entities should find at least one IfcWall.
    const walls = await send<{ structuredContent: { count: number; entities: Array<{ globalId: string }> } }>(
      transport, 3, 'tools/call',
      { name: 'query_entities', arguments: { type: 'IfcWall' } },
    );
    expect(walls.structuredContent.count).toBeGreaterThanOrEqual(1);
    expect(walls.structuredContent.entities[0].globalId).toMatch(/^[0-9A-Za-z_$]+$/);

    // count_entities by type returns a histogram.
    const counts = await send<{ structuredContent: { groups: Array<{ key: string; count: number }> } }>(
      transport, 4, 'tools/call',
      { name: 'count_entities', arguments: { group_by: 'type' } },
    );
    expect(counts.structuredContent.groups.length).toBeGreaterThan(0);
    expect(counts.structuredContent.groups.some((g) => /WALL/i.test(g.key))).toBe(true);

    // model_audit always returns a score in [0,100].
    const audit = await send<{ structuredContent: { overall: number } }>(
      transport, 5, 'tools/call',
      { name: 'model_audit', arguments: {} },
    );
    expect(audit.structuredContent.overall).toBeGreaterThanOrEqual(0);
    expect(audit.structuredContent.overall).toBeLessThanOrEqual(100);

    // resources/list should advertise the manifest.
    const resources = await send<{ resources: Array<{ uri: string }> }>(transport, 6, 'resources/list');
    expect(resources.resources.some((r) => r.uri.endsWith('/manifest'))).toBe(true);

    // prompts/list — every default prompt must be present.
    const prompts = await send<{ prompts: Array<{ name: string }> }>(transport, 7, 'prompts/list');
    expect(prompts.prompts.map((p) => p.name)).toContain('audit_model');

    // model_save round-trip — the saved IFC is still parsable.
    const savedPath = join(tmp, 'saved.ifc');
    const saveResult = await send<{ structuredContent: { bytes: number } }>(
      transport, 8, 'tools/call',
      { name: 'model_save', arguments: { file_path: savedPath } },
    );
    expect(saveResult.structuredContent.bytes).toBeGreaterThan(0);
    const saved = await readFile(savedPath, 'utf-8');
    expect(saved.startsWith('ISO-10303-21')).toBe(true);

    // ids_validate round-trip — locks in the @xmldom/xmldom fallback that
    // makes the IDS parser work in plain Node (no global DOMParser). Before
    // the fix this throws INTERNAL_ERROR("DOMParser is not defined").
    const idsPath = join(tmp, 'mini.ids');
    await writeFile(idsPath, `<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS"
     xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <info><title>Walls must exist</title></info>
  <specifications>
    <specification name="Walls" ifcVersion="IFC2X3 IFC4">
      <applicability minOccurs="1" maxOccurs="unbounded">
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <attribute><name><simpleValue>Name</simpleValue></name></attribute>
      </requirements>
    </specification>
  </specifications>
</ids>
`, 'utf-8');
    const ids = await send<{ isError?: boolean; structuredContent?: Record<string, unknown> }>(
      transport, 9, 'tools/call',
      { name: 'ids_validate', arguments: { ids_path: idsPath } },
    );
    expect(ids.isError).toBeFalsy();
    expect(ids.structuredContent).toBeTruthy();

    transport.close();
  });
});

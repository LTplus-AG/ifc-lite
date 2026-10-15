/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7610: the MCP loader silenced the parser's console during a load and passed
 * no onDiagnostic, so a model whose scan dropped a record (an unescaped
 * apostrophe, #7541) loaded with no sign it was short. PR #7632 now
 * rejects unterminated lexical input at the envelope boundary; a balanced
 * record missing its semicolon still exercises the short-scan diagnostic.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadIfcModel } from './loader.js';
import { createMCPServer, fullScope, InMemoryModelRegistry, InProcessTransport } from './index.js';

const gid = (n: number) => String(n).padStart(22, '0');
function fileWith(name20: string, terminated = true): string {
  const path = join(mkdtempSync(join(tmpdir(), 'mcp-7610-')), 'model.ifc');
  writeFileSync(path, [
    'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION((''),'2;1');", "FILE_NAME('a','',(''),(''),'','','');",
    "FILE_SCHEMA(('IFC4'));", 'ENDSEC;', 'DATA;',
    `#1=IFCPROJECT('${gid(1)}',$,'P',$,$,$,$,$,#3);`, '#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);', '#3=IFCUNITASSIGNMENT((#2));',
    `#20=IFCWALL('${gid(20)}',$,${name20},$,$,$,$,$,$)${terminated ? ';' : ''}`, `#21=IFCWALL('${gid(21)}',$,'W2',$,$,$,$,$,$);`,
    'ENDSEC;', 'END-ISO-10303-21;', '',
  ].join('\n'));
  return path;
}

describe('an MCP model the scan read short says so (#7610)', () => {
  it('refuses a lexical truncation before returning a partial model (PR #7632)', async () => {
    await expect(loadIfcModel(fileWith("'it's'"))).rejects.toMatchObject({ code: 'TRUNCATED_STEP' });
  });
  it('carries the dropped-record diagnostic on the loaded model', async () => {
    const loaded = await loadIfcModel(fileWith("'wall'", false));
    expect(loaded.store.entityIndex.byId.has(20)).toBe(false);
    expect(loaded.scanWarnings).toHaveLength(1);
    expect(loaded.scanWarnings?.[0]).toMatch(/^scan: dropped a record with no terminating ';'/);
  });

  it('carries nothing for a model read in full', async () => {
    const loaded = await loadIfcModel(fileWith("'it''s'"));
    expect(loaded.store.entityIndex.byId.has(20)).toBe(true);
    expect(loaded.scanWarnings).toBeUndefined();
  });
});

describe('an MCP tool that misses an entity in a short model says why (#7610)', () => {
  async function call(file: string, name: string, args: Record<string, unknown>, modelIds?: string[]) {
    const registry = new InMemoryModelRegistry();
    registry.add(await loadIfcModel(file, { modelId: 'm' }));
    const transport = new InProcessTransport();
    const scope = modelIds ? { ...fullScope(), modelIds } : fullScope();
    void transport.connect(createMCPServer({ version: '0.0.0-test', registry, scope }));
    await transport.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    const res = await transport.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }) as
      { result: { isError?: boolean; structuredContent?: { code?: string; hint?: string; results?: { ok: boolean; hint?: string }[] } } };
    return res.result;
  }

  it('hints at the dropped records when a write misses #20 of a short model', async () => {
    const r = await call(fileWith("'wall'", false), 'entity_set_property', { model_id: 'm', express_id: 20, pset: 'P', name: 'N', value: 1 });
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.code).toBe('ENTITY_NOT_FOUND');
    expect(r.structuredContent?.hint).toMatch(/Model 'm' was read short: the scan dropped or skipped records/);
  });

  it('gives no such hint when the model was read in full', async () => {
    const r = await call(fileWith("'it''s'"), 'entity_set_property', { model_id: 'm', express_id: 99, pset: 'P', name: 'N', value: 1 });
    expect(r.structuredContent?.code).toBe('ENTITY_NOT_FOUND');
    expect(r.structuredContent?.hint ?? '').not.toMatch(/read short/);
  });

  it('hints inside mutation_batch, which runs its sub-tools without the dispatcher', async () => {
    const r = await call(fileWith("'wall'", false), 'mutation_batch', {
      model_id: 'm', operations: [{ tool: 'entity_set_property', args: { express_id: 20, pset: 'P', name: 'N', value: 1 } }],
    });
    expect(r.structuredContent?.results?.[0]?.ok).toBe(false);
    expect(r.structuredContent?.results?.[0]?.hint).toMatch(/Model 'm' was read short/);
  });

  it('never mentions a model the caller may not access', async () => {
    const r = await call(fileWith("'wall'", false), 'bcf_topic_close', { guid: 'no-such-topic' }, ['other']);
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.hint ?? '').not.toMatch(/read short/);
  });
});

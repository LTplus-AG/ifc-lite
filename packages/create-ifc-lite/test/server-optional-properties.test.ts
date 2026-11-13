/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
vi.mock('../src/utils/config-fixers.js', async original => ({
  ...(await original<typeof import('../src/utils/config-fixers.js')>()),
  getPinnedPackageVersion: () => '1.0.0',
}));
import { createServerTemplate } from '../src/templates/server.js';

it.each(['properties', 'stream'] as const)('#9538 generated streaming example classifies %s failure correctly', async failure => {
  const target = fs.mkdtempSync(join(tmpdir(), 'ifc-server-example-'));
  const exits: number[] = [], warnings: unknown[][] = [];
  let propertyCalls = 0;
  try {
    createServerTemplate(target, 'optional-properties');
    const model = join(target, 'fixture.ifc'); fs.writeFileSync(model, 'inline fixture');
    class Client {
      async health() { return { status: 'ok' }; }
      async isParquetSupported() { return true; }
      async parseParquetStream(_buffer: ArrayBuffer, onBatch: (batch: { batch_number: number; meshes: unknown[]; decode_time_ms: number }) => void) {
        if (failure === 'stream') throw new Error('stream unavailable');
        onBatch({ batch_number: 1, meshes: [{}], decode_time_ms: 0 });
        return { total_meshes: 1, cache_key: 'test-cache', stats: { parse_time_ms: 1, geometry_time_ms: 1, total_triangles: 1 } };
      }
      async fetchDataModel() { propertyCalls++; throw new Error('properties unavailable'); }
    }
    // Execute the real scaffold output, not a source-string assertion.
    const source = fs.readFileSync(join(target, 'src', 'example-stream.ts'), 'utf8');
    const script = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    await runInNewContext(script, {
      exports: {}, performance,
      require: (id: string) => { if (id === '@ifc-lite/server-client') return { IfcServerClient: Client }; if (id === 'fs') return fs; throw new Error(`Unexpected import ${id}`); },
      process: { env: {}, argv: ['node', 'example-stream.ts', model], exit: (code: number) => { exits.push(code); } },
      console: { log() {}, error() {}, warn: (...args: unknown[]) => { warnings.push(args); } },
    });
    expect(exits).toEqual(failure === 'stream' ? [1] : []);
    expect(propertyCalls).toBe(failure === 'stream' ? 0 : 1);
    if (failure === 'properties') expect(warnings.flat().map(String).join(' ')).toContain('properties');
  } finally { fs.rmSync(target, { recursive: true, force: true }); }
});

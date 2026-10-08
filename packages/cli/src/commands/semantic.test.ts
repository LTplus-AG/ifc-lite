/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6643: CLI validates actual documents through the shared engines and preserves machine output. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PROFILE, toRdf } from '@ifc-lite/semantic';
import { semanticCommand } from './semantic.js';
let directory: string;
let output: string;
const source = 'https://example.org/original-charter-fixture';
const good = { profile: DEFAULT_PROFILE.id, source, completeness: 'complete' as const,
  resources: [{ id: `${source}/building`, type: 'Building', label: 'Original test building' }] };
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ifc-lite-semantic-cli-')); output = ''; process.exitCode = 0;
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { output += String(chunk); return true; });
});
afterEach(async () => { vi.restoreAllMocks(); process.exitCode = 0; await rm(directory, { recursive: true, force: true }); });
describe('semantic CLI #6643', () => {
  it('returns JSON Schema/link findings and failure exit code for a complete broken relationship', async () => {
    const path = join(directory, 'records.json');
    await writeFile(path, JSON.stringify({ ...good, resources: [...good.resources,
      { id: `${source}/logbook`, type: 'Logbook', label: 'Logbook', buildingId: `${source}/missing` },
      { id: `${source}/passport`, type: 'Passport', label: 'Incomplete passport' },
    ] }));
    await semanticCommand(['validate', path, '--json']);
    const report = JSON.parse(output); expect(report.conforms).toBe(false); expect(process.exitCode).toBe(1);
    expect(report.findings).toEqual(expect.arrayContaining([expect.objectContaining({ engine: 'links', path: 'buildingId' }), expect.objectContaining({ engine: 'JSON Schema', path: 'productId' })]));
  });
  it('produces conforming output and generated SHACL agrees on original valid data', async () => {
    const path = join(directory, 'records.json'); await writeFile(path, JSON.stringify(good));
    await semanticCommand(['validate', path, '--json']); expect(JSON.parse(output).conforms).toBe(true); expect(process.exitCode).toBe(0);
    output = ''; const graph = join(directory, 'graph.nq'); await writeFile(graph, await toRdf(good));
    await semanticCommand(['validate', graph, '--json']); expect(JSON.parse(output)).toMatchObject({ conforms: true, engines: ['SHACL'] });
  });
  it('does not declare invalid syntax, duplicate identifiers or unknown fields conforming', async () => {
    const path = join(directory, 'bad.json');
    for (const content of ['{', JSON.stringify({ ...good, resources: [...good.resources, ...good.resources] }), JSON.stringify({ ...good, resources: [{ ...good.resources[0], invented: true }] })]) {
      await writeFile(path, content); await expect(semanticCommand(['validate', path, '--json'])).rejects.toThrow(); expect(output).toBe('');
    }
  });
  it('loads an original custom profile and exports its generated context/shape standards', async () => {
    const profile = { id: 'https://example.org/test-profile', version: '1.0.0', vocabulary: 'https://example.org/test#',
      fields: { label: { iri: 'https://example.org/test#label', kind: 'string' }, count: { iri: 'https://example.org/test#count', kind: 'integer', minimum: 1 } },
      types: { Item: { iri: 'https://example.org/test#Item', fields: { label: { minCount: 1, maxCount: 1 }, count: { minCount: 1, maxCount: 1 } } } } };
    const path = join(directory, 'profile.json'); await writeFile(path, JSON.stringify(profile));
    await semanticCommand(['assets', '--profile', path, '--artifact', 'context', '--json']);
    expect(JSON.parse(output).count['@type']).toBe('http://www.w3.org/2001/XMLSchema#integer');
    const out = join(directory, 'shapes.ttl'); await semanticCommand(['assets', '--profile', path, '--artifact', 'shapes', '--out', out]);
    expect(await readFile(out, 'utf8')).toContain('minInclusive');
    const doc = join(directory, 'custom.json'); await writeFile(doc, JSON.stringify({ profile: profile.id, source, completeness: 'complete', resources: [{ id: `${source}/item`, type: 'Item', label: 'One', count: 1 }] }));
    output = ''; await semanticCommand(['validate', doc, '--profile', path, '--json']); expect(JSON.parse(output).conforms).toBe(true);
  });
  it('rejects unsupported/misplaced flags and missing credential references before making a network request', async () => {
    for (const args of [['query', '--endpoint', 'https://example.org', '--host', 'example.org', '--bearer-env', '__SEMANTIC_TEST_UNSET__'],
      ['query', '--endpoint', 'https://example.org', '--host', 'example.org', '--kind', 'delete'], ['assets', '--rdf'], ['assets', '--invented'], ['validate'], ['assets', '--out']]) {
      await expect(semanticCommand(args)).rejects.toThrow();
    }
    const path = join(directory, 'mutation.rq'); await writeFile(path, 'DELETE WHERE {?s ?p ?o}');
    await expect(semanticCommand(['query', '--endpoint', 'https://example.org', '--host', 'example.org', '--query', path])).rejects.toThrow('Only SELECT');
  });
  it('bounds files before parsing and rejects no-target graph checks', async () => {
    const path = join(directory, 'too-large.json'); await writeFile(path, ' '.repeat(5 * 1024 * 1024 + 1));
    await expect(semanticCommand(['validate', path])).rejects.toThrow('byte limit');
    const graph = join(directory, 'graph.ttl'); await writeFile(graph, '<https://example.org/s> <https://example.org/p> "v" .');
    await expect(semanticCommand(['validate', graph, '--json'])).rejects.toThrow(/No .*targets.*SHACL/);
  });
  it('rejects unsupported and missing relay provider kinds before reading TLS files #6643', async () => {
    const path = join(directory, 'relay.json');
    for (const kind of [undefined, 'select', 'construct', null]) {
      await writeFile(path, JSON.stringify({ clientTokenEnv: '__SEMANTIC_TEST_UNSET__', allowedOrigins: [],
        providers: { demo: { endpoint: 'https://example.org/data', grantedHost: 'example.org', kind } } }));
      await expect(semanticCommand(['serve', '--config', path, '--cert', join(directory, 'absent.crt'), '--key', join(directory, 'absent.key')]))
        .rejects.toThrow('Invalid relay provider');
    }
  });
  it('reads a real loopback SELECT only with explicit boolean authorization #6784', async () => {
    const server = createServer((_request, response) => {
      response.setHeader('Content-Type', 'application/sparql-results+json');
      response.end(JSON.stringify({ head: { vars: ['label'] }, results: { bindings: [{ label: { type: 'literal', value: 'original CLI local result' } }] } }));
    }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/sparql`;
      const path = join(directory, 'query.rq'); await writeFile(path, 'SELECT * WHERE {?s ?p ?o}');
      const args = ['query', '--endpoint', endpoint, '--host', '127.0.0.1', '--query', path, '--json'];
      await expect(semanticCommand(args)).rejects.toThrow(); expect(output).toBe('');
      await semanticCommand([...args, '--allow-loopback-http']);
      expect(JSON.parse(output).results.bindings[0].label.value).toBe('original CLI local result');
      for (const suffix of [['--allow-loopback-http', 'false'], ['--allow-loopback-http', '--allow-loopback-http']]) {
        await expect(semanticCommand([...args, ...suffix])).rejects.toThrow();
      }
      await expect(semanticCommand(['query', '--endpoint', 'http://example.org', '--host', 'example.org', '--allow-loopback-http'])).rejects.toThrow('literal loopback');
    } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });

});

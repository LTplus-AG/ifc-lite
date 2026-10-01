#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Reproducible headless resource-budget probe for #6643; reports evidence, never a CI gate.
 * Run after the root build: node scripts/perf/semantic-budget.mjs --iters 5 > /tmp/semantic-budget.json
 * The loopback HTTP test transport changes byte movement only: production provider HTTPS/host gates still run.
 */
import { createServer } from 'node:http';
import { once } from 'node:events';
import { cpus, platform, release, totalmem } from 'node:os';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createSemanticProvider, parseResults, recordsFromResults, recordsFromGraph, exportWorkspace, importWorkspace, LIMITS } from '../../packages/semantic/dist/index.js';
const args = process.argv.slice(2);
const iterations = args.length === 0 ? 5 : args.length === 2 && args[0] === '--iters' ? Number(args[1]) : NaN;
if (!Number.isInteger(iterations) || iterations < 1 || iterations > 100) throw new Error('Usage: semantic-budget.mjs [--iters 1..100]');
const root = 'https://example.org/charter-6643/budget/';
const columns = ['subject', 'predicate', 'object'];
const bindings = Array.from({ length: LIMITS.rows }, (_, i) => ({ subject: { type: 'uri', value: `${root}subject-${i % 500}` },
  predicate: { type: 'uri', value: `${root}measurement` }, object: { type: 'literal', value: String(i), datatype: 'http://www.w3.org/2001/XMLSchema#integer' } }));
const payload = JSON.stringify({ head: { vars: columns }, results: { bindings } });
const graph = bindings.map(row => `<${row.subject.value}> <${row.predicate.value}> "${row.object.value}"^^<${row.object.datatype}> .`).join('\n');
let slowRequests = 0; const timers = new Set();
const server = createServer(async (incoming, outgoing) => {
  for await (const _ of incoming) { /* consume the bounded provider POST query */ }
  if (incoming.url === '/slow') {
    slowRequests++;
    const timer = setTimeout(() => { timers.delete(timer); outgoing.end('{}'); }, 5000); timers.add(timer); return;
  }
  outgoing.setHeader('Content-Type', incoming.url === '/graph' ? 'text/turtle' : 'application/sparql-results+json');
  outgoing.end(incoming.url === '/graph' ? graph : payload);
}).listen(0, '127.0.0.1');
await once(server, 'listening');
const port = server.address().port;
const provider = createSemanticProvider((url, init) => fetch(`http://127.0.0.1:${port}${url.pathname}`, init));
const samples = [];
function timed(fn) { const start = performance.now(); const value = fn(); return { value, ms: performance.now() - start }; }
try {
  for (let iteration = 0; iteration < iterations; iteration++) {
    const before = process.memoryUsage();
    const parse = timed(() => parseResults(JSON.parse(payload)));
    const records = timed(() => recordsFromResults(parse.value));
    const rdf = timed(() => recordsFromGraph(graph));
    assert.equal(records.value.length, 500); assert.equal(rdf.value.length, 500);
    assert.equal(records.value[0].properties[`${root}measurement`].length, 10);
    const workspace = timed(() => exportWorkspace({ version: 1, datasets: [{ id: `${root}dataset`, source: root, completeness: 'complete', rows: parse.value,
      resources: records.value, graph, graphFormat: 'text/turtle' }], queries: [], revisions: [] }));
    const restored = timed(() => importWorkspace(workspace.value));
    assert.equal(restored.value.grants.length, 0); assert.equal(restored.value.associations.size, 0);
    assert.deepEqual(restored.value.workspace.datasets[0].rows, parse.value);
    const networkStart = performance.now();
    const select = await provider.read({ endpoint: 'https://budget.example.org/select', host: 'budget.example.org', kind: 'select', query: 'SELECT ?subject ?predicate ?object WHERE {?subject ?predicate ?object} LIMIT 5000' });
    assert.equal(select.kind, 'select'); assert.equal(select.value.rows.length, LIMITS.rows);
    const selectMs = performance.now() - networkStart;
    const graphStart = performance.now();
    const constructed = await provider.read({ endpoint: 'https://budget.example.org/graph', host: 'budget.example.org', kind: 'construct', query: 'CONSTRUCT {?subject ?predicate ?object} WHERE {?subject ?predicate ?object} LIMIT 5000' });
    assert.equal(constructed.kind, 'construct'); assert.equal(constructed.quadCount, LIMITS.rows);
    samples.push({ iteration: iteration + 1, parseMs: parse.ms, recordsMs: records.ms, graphMs: rdf.ms,
      workspaceExportMs: workspace.ms, workspaceImportMs: restored.ms, selectRoundtripMs: selectMs,
      constructRoundtripMs: performance.now() - graphStart, heapDeltaBytes: process.memoryUsage().heapUsed - before.heapUsed,
      workspaceBytes: Buffer.byteLength(workspace.value) });
  }
  assert.throws(() => parseResults({ head: { vars: columns }, results: { bindings: [...bindings, bindings[0]] } }), /bounded|limit/i);
  await assert.rejects(provider.read({ endpoint: 'https://budget.example.org/select', host: 'different.example.org', kind: 'select', query: 'SELECT * WHERE {?s ?p ?o}' }));
  const controller = new AbortController(); const cancelStart = performance.now();
  const pending = provider.read({ endpoint: 'https://budget.example.org/slow', host: 'budget.example.org', kind: 'json' }, controller.signal);
  const timer = setTimeout(() => controller.abort(), 25);
  try { await assert.rejects(pending, /cancelled/i); } finally { clearTimeout(timer); }
  assert.equal(slowRequests, 1);
  const cancellationMs = performance.now() - cancelStart;
  const median = key => [...samples.map(sample => sample[key])].sort((a, b) => a - b)[Math.floor(samples.length / 2)];
  console.log(JSON.stringify({ charter: 'https://github.com/LTplus-AG/ifc-lite/issues/6643', command: `node scripts/perf/semantic-budget.mjs --iters ${iterations}`,
    environment: { node: process.version, platform: platform(), release: release(), arch: process.arch, cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem() },
    limits: LIMITS, input: { rows: LIMITS.rows, quads: LIMITS.rows, subjects: 500, selectBytes: Buffer.byteLength(payload), rdfBytes: Buffer.byteLength(graph) },
    verified: { retainedValuesPerSubject: 10, restoredRowsIdentical: true, importedGrantsEmpty: true, importedAssociationsEmpty: true, excessRowsRefused: true, ungrantedHostRefused: true, cancellationRequests: slowRequests },
    medianMs: Object.fromEntries(['parseMs', 'recordsMs', 'graphMs', 'workspaceExportMs', 'workspaceImportMs', 'selectRoundtripMs', 'constructRoundtripMs'].map(key => [key, median(key)])),
    cancellationMs, samples }, null, 2));
} finally {
  for (const timer of timers) clearTimeout(timer);
  server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Second-process certificate verifier for B4.5 (the M1 midterm as literally
 * worded).
 *
 * Same contract as `scripts/moonshot/b35-demo/verify-worker.mjs`, extended
 * with the one thing that demo did not need: `geometry-mesh` payloads. Typed
 * arrays do not survive JSON, so the bundle carries `positions`/`normals`/
 * `indices` as base64 of their exact little-endian bytes and this worker
 * revives them into the same Float32Array/Uint32Array views the producer
 * hashed. Nothing about the hash is re-implemented here — `hashResolvedNode`
 * inside `verifyCertificate` does the work; the revival only has to hand it
 * byte-identical arrays.
 *
 * Reads a bundle `{ certificate, expectedTrustRoot, expectedKernelVersion,
 * nodes }` from argv[2] and prints ONE JSON verdict line:
 *   { ok, reason?, nodesResolved, uniqueNodesResolved, verifyMs,
 *     bundleParseMs, maxRssBytes }
 *
 * Being a separate `node` invocation is the point: this process shares no
 * memory with the one that produced the certificate. Everything it knows about
 * the 169 MB model arrives through `bundle` — the certificate plus exactly the
 * payloads its resolver asked for. It never sees the fixture, the parse, the
 * mesh pass, or the other ~1e6 DAG nodes.
 */

import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');

const { verifyCertificate } = await import(
  path.join(REPO_ROOT, 'packages/provenance/dist/index.js')
);

const bundlePath = process.argv[2];
if (!bundlePath) {
  process.stderr.write('Usage: node verify-worker.mjs <bundle.json>\n');
  process.exit(2);
}

/** Revive `{ __ta: 'f32'|'u32', b64 }` into the exact typed array the producer
 *  hashed. Buffer.from(base64) may return a view into a pooled ArrayBuffer, so
 *  the byteOffset is honoured rather than assumed to be 0. */
function reviveTypedArray(v) {
  const buf = Buffer.from(v.b64, 'base64');
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return v.__ta === 'f32' ? new Float32Array(ab) : new Uint32Array(ab);
}

function reviveNode(node) {
  if (node === undefined || node === null) return undefined;
  if (node.kind !== 'geometry-mesh') return node;
  const p = node.payload;
  return {
    kind: 'geometry-mesh',
    payload: {
      expressId: p.expressId,
      geometryClass: p.geometryClass,
      positions: reviveTypedArray(p.positions),
      normals: reviveTypedArray(p.normals),
      indices: reviveTypedArray(p.indices),
      origin: p.origin,
    },
  };
}

const parseStart = performance.now();
const bundle = JSON.parse(readFileSync(bundlePath, 'utf-8'));
// Revive eagerly, BEFORE the timed region: base64 decoding is transport
// deserialization, not verification. It is reported separately as
// `bundleParseMs` so nothing is hidden — see REPORT.md.
const revived = Object.create(null);
for (const [id, node] of Object.entries(bundle.nodes)) revived[id] = reviveNode(node);
const bundleParseMs = Number((performance.now() - parseStart).toFixed(3));

let nodesResolved = 0;
const uniqueIds = new Set();
const resolver = async (nodeId) => {
  nodesResolved++;
  uniqueIds.add(nodeId);
  return revived[nodeId];
};

const t0 = performance.now();
const result = await verifyCertificate(bundle.certificate, resolver, {
  expectedTrustRoot: bundle.expectedTrustRoot,
  expectedKernelVersion: bundle.expectedKernelVersion,
});
const verifyMs = Number((performance.now() - t0).toFixed(3));

process.stdout.write(
  `${JSON.stringify({
    ok: result.ok,
    reason: result.ok ? undefined : result.reason,
    details: result.ok ? undefined : result.details,
    nodesResolved,
    uniqueNodesResolved: uniqueIds.size,
    verifyMs,
    bundleParseMs,
    maxRssBytes: process.resourceUsage().maxRSS * 1024,
  })}\n`,
);

#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Second-process certificate verifier for ACT 2 of the B3.5 demo.
 *
 * Reads a bundle `{ certificate, expectedTrustRoot, expectedKernelVersion,
 * nodes }` from the path in argv[2], verifies the certificate with
 * @ifc-lite/provenance's `verifyCertificate` against a counting resolver
 * over the bundled payloads (every referenced hash is RE-DERIVED, nothing
 * in the certificate is trusted), and prints one JSON verdict line:
 * `{ ok, reason?, nodesResolved, verifyMs }`.
 *
 * Being a separate `node` invocation is the point: the verifier shares no
 * memory with the process that produced the certificate.
 */

import { readFile } from 'node:fs/promises';
import { verifyCertificate } from '../../../packages/provenance/dist/index.js';

const bundlePath = process.argv[2];
if (!bundlePath) {
  process.stderr.write('Usage: node verify-worker.mjs <bundle.json>\n');
  process.exit(2);
}

const bundle = JSON.parse(await readFile(bundlePath, 'utf-8'));

let nodesResolved = 0;
const resolver = async (nodeId) => {
  nodesResolved++;
  return bundle.nodes[nodeId];
};

const t0 = performance.now();
const result = await verifyCertificate(bundle.certificate, resolver, {
  expectedTrustRoot: bundle.expectedTrustRoot,
  expectedKernelVersion: bundle.expectedKernelVersion,
});
const verifyMs = Number((performance.now() - t0).toFixed(3));

process.stdout.write(`${JSON.stringify({
  ok: result.ok,
  reason: result.ok ? undefined : result.reason,
  nodesResolved,
  verifyMs,
})}\n`);

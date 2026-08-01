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
 * THE TRUST ANCHOR DOES NOT COME FROM THE BUNDLE. An earlier revision of this
 * file read `expectedTrustRoot`/`expectedKernelVersion` out of the bundle it
 * was checking, which makes the spec §4 pin vacuous: a forger ships whatever
 * anchor they want compared against and it matches by construction. That was
 * not theoretical — a bundle with a tampered child hash under a
 * `subtree-untouched` storey, its claim hash re-derived so the certificate
 * agreed with the lie, and an attacker-chosen trustRoot/kernelVersion pair
 * stamped on both the certificate and the bundle's `expected*` fields,
 * verified `ok: true` and resolved all 60 nodes — indistinguishable from the
 * genuine bundle. Both expectations now arrive from the parent process
 * (`B45_EXPECT_TRUST_ROOT` / `B45_EXPECT_KERNEL_VERSION`), which the bundle
 * cannot reach; a bundle that still carries the fields is rejected outright
 * rather than merely ignored, so the attack is visible instead of inert.
 *
 * Reads a bundle `{ certificate, nodes }` from argv[2] and prints EXACTLY ONE
 * JSON verdict line, whatever happens:
 *   { ok, reason?, nodesResolved, uniqueNodesResolved, verifyMs,
 *     bundleParseMs, maxRssBytes }
 * A malformed bundle, an unreadable file, a bad base64 blob or a throw from
 * anywhere in the load/revive/verify path is a verification FAILURE for that
 * bundle (`ok: false` with a deterministic reason), never a lost result and
 * never an aborted run — a verifier that crashes on bad input silently drops
 * that bundle out of the count instead of counting it as rejected.
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

/** A bundle-level defect. Carries the reason the verdict line will report, so
 *  every rejection path produces the same shape as `verifyCertificate`'s. */
class BundleError extends Error {
  constructor(reason, details) {
    super(reason);
    this.reason = reason;
    this.details = details;
  }
}

let nodesResolved = 0;
const uniqueIds = new Set();
let bundleParseMs = 0;
let verifyMs = 0;

let emitted = false;

/**
 * Print the one and only verdict line, and set the exit code without calling
 * `process.exit`. On macOS stdout to a PIPE is asynchronous, and this worker is
 * always read through one (`spawnSync`), so exiting immediately after the write
 * can truncate the verdict — the exact "result lost" failure the wrapping
 * exists to prevent. Setting `process.exitCode` and letting the event loop
 * drain flushes it.
 */
function emit(verdict, exitCode = 0) {
  if (emitted) return;
  emitted = true;
  process.exitCode = exitCode;
  process.stdout.write(
    `${JSON.stringify({
      ...verdict,
      nodesResolved,
      uniqueNodesResolved: uniqueIds.size,
      verifyMs,
      bundleParseMs,
      maxRssBytes: process.resourceUsage().maxRSS * 1024,
    })}\n`,
  );
}

const TYPED_ARRAY_CTORS = { f32: Float32Array, u32: Uint32Array };

/** Revive `{ __ta: 'f32'|'u32', b64 }` into the exact typed array the producer
 *  hashed. Buffer.from(base64) may return a view into a pooled ArrayBuffer, so
 *  the byteOffset is honoured rather than assumed to be 0.
 *
 *  Every field is checked. `Buffer.from(s, 'base64')` never throws — it drops
 *  characters it does not understand and truncates a ragged tail — so a
 *  corrupted blob would otherwise revive into a SHORTER array that hashes to
 *  something plausible-looking rather than being rejected. The tag is looked up
 *  in an explicit table for the same reason: the previous `=== 'f32' ? … :
 *  Uint32Array` fallback turned any unknown or missing tag into a u32 array. */
function reviveTypedArray(v, where) {
  if (v === null || typeof v !== 'object') {
    throw new BundleError('malformed-typed-array', { where, got: typeof v });
  }
  const Ctor = TYPED_ARRAY_CTORS[v.__ta];
  if (!Ctor) {
    throw new BundleError('unsupported-typed-array-tag', { where, tag: v.__ta });
  }
  if (typeof v.b64 !== 'string') {
    throw new BundleError('malformed-typed-array', { where, b64: typeof v.b64 });
  }
  const buf = Buffer.from(v.b64, 'base64');
  if (buf.toString('base64') !== v.b64) {
    throw new BundleError('invalid-base64', { where, length: v.b64.length });
  }
  if (buf.byteLength % Ctor.BYTES_PER_ELEMENT !== 0) {
    throw new BundleError('typed-array-byte-length', {
      where,
      byteLength: buf.byteLength,
      bytesPerElement: Ctor.BYTES_PER_ELEMENT,
    });
  }
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Ctor(ab);
}

function reviveNode(id, node) {
  if (node === undefined || node === null) return undefined;
  if (typeof node !== 'object') throw new BundleError('malformed-node', { nodeId: id });
  if (node.kind !== 'geometry-mesh') return node;
  const p = node.payload;
  if (p === null || typeof p !== 'object') {
    throw new BundleError('malformed-node', { nodeId: id, kind: node.kind });
  }
  return {
    kind: 'geometry-mesh',
    payload: {
      expressId: p.expressId,
      geometryClass: p.geometryClass,
      positions: reviveTypedArray(p.positions, `${id}.positions`),
      normals: reviveTypedArray(p.normals, `${id}.normals`),
      indices: reviveTypedArray(p.indices, `${id}.indices`),
      origin: p.origin,
    },
  };
}

async function run() {
  const bundlePath = process.argv[2];
  if (!bundlePath) {
    process.stderr.write('Usage: node verify-worker.mjs /path/to/bundle.json\n');
    emit({ ok: false, reason: 'no-bundle-path' }, 2);
    return;
  }

  /* --- The trust anchor, from the parent process, before anything is read --- */
  const expectedTrustRoot = process.env.B45_EXPECT_TRUST_ROOT;
  const expectedKernelVersion = process.env.B45_EXPECT_KERNEL_VERSION;
  if (!expectedTrustRoot || !expectedKernelVersion) {
    process.stderr.write(
      'verify-worker: B45_EXPECT_TRUST_ROOT and B45_EXPECT_KERNEL_VERSION must both be set by the\n' +
        'runner. They are the caller\'s "this is the kernel build I trust" pin (spec §4) and must\n' +
        'never be read out of the artifact being verified.\n',
    );
    emit({ ok: false, reason: 'missing-trusted-expectation' }, 2);
    return;
  }

  const { verifyCertificate } = await import(
    path.join(REPO_ROOT, 'packages/provenance/dist/index.js')
  );

  const parseStart = performance.now();
  let bundle;
  try {
    bundle = JSON.parse(readFileSync(bundlePath, 'utf-8'));
  } catch (err) {
    throw new BundleError('unreadable-bundle', { message: String(err?.message ?? err) });
  }
  if (bundle === null || typeof bundle !== 'object') {
    throw new BundleError('malformed-bundle', { got: typeof bundle });
  }
  // A bundle has no business carrying the anchor it is checked against. Refuse
  // rather than ignore: silently dropping the field would let a forged bundle
  // look exactly like a genuine one right up to the verdict.
  if ('expectedTrustRoot' in bundle || 'expectedKernelVersion' in bundle) {
    throw new BundleError('bundle-carries-trust-anchor', {
      expectedTrustRoot: bundle.expectedTrustRoot,
      expectedKernelVersion: bundle.expectedKernelVersion,
    });
  }
  if (bundle.certificate === null || typeof bundle.certificate !== 'object') {
    throw new BundleError('malformed-bundle', { field: 'certificate' });
  }
  if (bundle.nodes === null || typeof bundle.nodes !== 'object') {
    throw new BundleError('malformed-bundle', { field: 'nodes' });
  }

  // Revive eagerly, BEFORE the timed region: base64 decoding is transport
  // deserialization, not verification. It is reported separately as
  // `bundleParseMs` so nothing is hidden — see REPORT.md.
  const revived = Object.create(null);
  for (const [id, node] of Object.entries(bundle.nodes)) revived[id] = reviveNode(id, node);
  bundleParseMs = Number((performance.now() - parseStart).toFixed(3));

  const resolver = async (nodeId) => {
    nodesResolved++;
    uniqueIds.add(nodeId);
    return revived[nodeId];
  };

  const t0 = performance.now();
  const result = await verifyCertificate(bundle.certificate, resolver, {
    expectedTrustRoot,
    expectedKernelVersion,
  });
  verifyMs = Number((performance.now() - t0).toFixed(3));

  emit({
    ok: result.ok,
    reason: result.ok ? undefined : result.reason,
    details: result.ok ? undefined : result.details,
  });
}

try {
  await run();
} catch (err) {
  emit(
    err instanceof BundleError
      ? { ok: false, reason: err.reason, details: err.details }
      : { ok: false, reason: 'verifier-threw', details: { message: String(err?.message ?? err) } },
  );
}

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
 * A malformed bundle, an unreadable file, a bad base64 blob, a bundle or payload
 * over the caps below, or a throw from anywhere in the load/revive/verify path
 * is a verification FAILURE for that bundle (`ok: false` with a deterministic
 * reason), never a lost result and never an aborted run — a verifier that
 * crashes on bad input silently drops that bundle out of the count instead of
 * counting it as rejected.
 *
 * Being a separate `node` invocation is the point: this process shares no
 * memory with the one that produced the certificate. Everything it knows about
 * the 169 MB model arrives through `bundle` — the certificate plus exactly the
 * payloads its resolver asked for. It never sees the fixture, the parse, the
 * mesh pass, or the other ~1e6 DAG nodes.
 */

import { closeSync, openSync, readSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');

/**
 * CAPS ON UNTRUSTED INPUT, AND WHERE THEY SIT.
 *
 * The bundle is the attacker-controlled side of the same trust boundary as the
 * anchor above: this process is handed a file and asked to spend memory on it
 * before a single hash has been checked. Nothing here amplifies — there is no
 * declared-length field sizing a buffer, so the cost is linear in the file — but
 * "linear in a number the attacker picks" is still unbounded, and the failure
 * mode without a cap is a heap abort, which produces no verdict line at all.
 * That is the one outcome the whole emit() contract exists to prevent: a
 * verifier that dies on bad input drops that bundle out of the count instead of
 * counting it as rejected.
 *
 * Both caps come from the parent, like the anchor, and both bound the
 * allocation itself rather than a number that describes it:
 *   - the bundle is read through ONE opened descriptor and the reads stop at
 *     `MAX_BUNDLE_BYTES + 1` bytes, so an oversized bundle is never held. The
 *     first revision instead did `statSync(path).size` and then
 *     `readFileSync(path)`, which bounds a DIFFERENT thing: `st_size` is not
 *     the number of bytes a read will yield. A FIFO, a character device
 *     (`/dev/zero`) or a socket stats as size 0, passes the check trivially,
 *     and then hands the reader as many bytes as its producer feels like -
 *     measured, an 8 MiB bundle streamed through a FIFO cleared a 1 MiB cap
 *     and was parsed and verified in full, and 512 MiB under the same 1 MiB
 *     cap took the worker to 1,072 MiB peak RSS. The cap was not loose there;
 *     it was inapplicable. Two syscalls against a path are also two chances
 *     for the path to mean two different files, so the size that was checked
 *     need not be the size that is read;
 *   - each payload's decoded size is computed from its base64 LENGTH before
 *     `Buffer.from` runs, and charged against a running total, so an oversized
 *     payload is never decoded.
 * The defaults are ~7x the largest bundle this bet produces (the 36.5 MB
 * element-granularity sensitivity bundle), so no honest run can reach them.
 */
const MiB = 1024 * 1024;

function capFromEnv(name, fallbackBytes) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallbackBytes;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    process.stderr.write(`verify-worker: ignoring ${name}=${JSON.stringify(raw)} (not a positive number)\n`);
    return fallbackBytes;
  }
  return Math.floor(n);
}

const MAX_BUNDLE_BYTES = capFromEnv('B45_MAX_BUNDLE_BYTES', 256 * MiB);
const MAX_PAYLOAD_BYTES = capFromEnv('B45_MAX_PAYLOAD_BYTES', 256 * MiB);

/** Upper bound on what `Buffer.from(s, 'base64')` can allocate, from the string
 *  length alone. Deliberately the ceiling rather than the exact size: this is a
 *  guard, and the exact byte count is charged after the decode. */
function maxDecodedBytes(b64Length) {
  return Math.ceil(b64Length / 4) * 3;
}

let decodedPayloadBytes = 0;

/** A bundle-level defect. Carries the reason the verdict line will report, so
 *  every rejection path produces the same shape as `verifyCertificate`'s. */
class BundleError extends Error {
  constructor(reason, details) {
    super(reason);
    this.reason = reason;
    this.details = details;
  }
}

/** Chunk size for the bounded read below. Small enough that an honest 1.6 MB
 *  bundle costs a couple of allocations, large enough that the 36.5 MB
 *  sensitivity bundle costs ~37 reads. */
const READ_CHUNK_BYTES = 1 * MiB;

/**
 * Read the whole bundle, or as much of it as the cap allows, through ONE
 * opened descriptor.
 *
 * The cap is enforced by not reading past it: at most `MAX_BUNDLE_BYTES + 1`
 * bytes ever leave the kernel, and the +1 is what distinguishes "exactly at the
 * cap" from "over it". Nothing here consults `st_size`, so the guarantee does
 * not depend on the path naming a regular file, or on it naming the same file
 * twice. Peak cost is bounded at ~2x the bytes actually read (the chunk list
 * plus the concatenation), and the string is only materialised for a bundle
 * that already passed.
 */
function readBundleBounded(bundlePath) {
  let fd;
  try {
    fd = openSync(bundlePath, 'r');
  } catch (err) {
    throw new BundleError('unreadable-bundle', { message: String(err?.message ?? err) });
  }
  try {
    const limit = MAX_BUNDLE_BYTES + 1;
    const scratch = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, limit));
    const chunks = [];
    let total = 0;
    while (total < limit) {
      let n;
      try {
        n = readSync(fd, scratch, 0, Math.min(scratch.length, limit - total), null);
      } catch (err) {
        throw new BundleError('unreadable-bundle', { message: String(err?.message ?? err) });
      }
      if (n === 0) break; // EOF
      chunks.push(Buffer.from(scratch.subarray(0, n)));
      total += n;
    }
    if (total > MAX_BUNDLE_BYTES) {
      throw new BundleError('bundle-too-large', {
        bundleBytesAtLeast: total,
        maxBundleBytes: MAX_BUNDLE_BYTES,
      });
    }
    return Buffer.concat(chunks, total).toString('utf-8');
  } finally {
    closeSync(fd);
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
  // Charged BEFORE the decode, from the string length: `Buffer.from` is the
  // allocation this cap exists to prevent, so it must not be the thing that
  // measures it. (The exactness check below re-encodes, costing another 4/3 of
  // the decoded size — also bounded by this cap.)
  const projected = maxDecodedBytes(v.b64.length);
  if (decodedPayloadBytes + projected > MAX_PAYLOAD_BYTES) {
    throw new BundleError('payload-too-large', {
      where,
      decodedSoFar: decodedPayloadBytes,
      declaredNext: projected,
      maxPayloadBytes: MAX_PAYLOAD_BYTES,
    });
  }
  const buf = Buffer.from(v.b64, 'base64');
  decodedPayloadBytes += buf.byteLength;
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

  /* --- The size cap, enforced on the bytes read rather than on st_size --- */
  const parseStart = performance.now();
  const text = readBundleBounded(bundlePath);
  let bundle;
  try {
    bundle = JSON.parse(text);
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

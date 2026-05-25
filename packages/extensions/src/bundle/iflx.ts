/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * .iflx packing and unpacking.
 *
 * Implementation note: the spec describes `.iflx` as "gzipped tar." In
 * v1 we implement it as a gzipped JSON envelope:
 *
 *   { format: "iflx", version: 1, files: { "<path>": "<base64>" } }
 *
 * Reasons:
 *   - Zero new dependencies beyond fflate (already in the workspace).
 *   - Order-independent file map → deterministic round-trip regardless
 *     of filesystem enumeration order.
 *   - Easier to inspect and diff.
 *
 * We can swap to tar later without changing the public API; the magic
 * version field gives us forward-compat.
 *
 * Spec: docs/architecture/ai-customization/01-extension-model.md §2.
 */

import { gunzipSync, gzipSync } from 'fflate';
import type {
  Bundle,
  BundleFile,
  ValidationResult,
} from '../types.js';
import { buildBundleFromFiles } from './loader.js';
import type { SignatureBlock } from '../signing/types.js';

const IFLX_MAGIC = 'iflx';
const IFLX_VERSION = 1;

const MAX_UNCOMPRESSED_BYTES = 8 * 1024 * 1024;
const MAX_PACKED_FILES = 1024;

interface IflxEnvelope {
  format: string;
  version: number;
  files: Record<string, string>;
  /** Optional signature block — present iff the bundle was signed. */
  signature?: SignatureBlock;
}

/** Result of `unpackBundleWithSignature`. */
export interface UnpackResult {
  bundle: Bundle;
  /** Raw signature block from the envelope, if present. */
  signature?: SignatureBlock;
}

/**
 * Pack a Bundle into a .iflx byte string (gzipped JSON envelope).
 * The resulting bytes are deterministic for a given input.
 *
 * Pass `signature` to produce a signed bundle. The signature is
 * authored by the caller via `signBundle` from `../signing` and
 * commits to the bundle's canonical content hash.
 */
export function packBundle(bundle: Bundle, signature?: SignatureBlock): Uint8Array {
  const files: Record<string, string> = {};
  // Sort for deterministic output.
  const keys = [...bundle.files.keys()].sort();
  for (const key of keys) {
    const f = bundle.files.get(key);
    if (!f) continue;
    files[key] = toBase64(f.bytes);
  }
  const envelope: IflxEnvelope = {
    format: IFLX_MAGIC,
    version: IFLX_VERSION,
    files,
    ...(signature ? { signature } : {}),
  };
  const json = JSON.stringify(envelope);
  return gzipSync(new TextEncoder().encode(json));
}

/**
 * Unpack a .iflx byte string into a validated Bundle.
 */
export function unpackBundle(bytes: Uint8Array): ValidationResult<Bundle> {
  let json: string;
  try {
    const unzipped = gunzipSync(bytes);
    if (unzipped.byteLength > MAX_UNCOMPRESSED_BYTES) {
      return fail('', 'invalid_format',
        `Bundle uncompressed size ${unzipped.byteLength} exceeds limit ${MAX_UNCOMPRESSED_BYTES}.`);
    }
    json = new TextDecoder('utf-8', { fatal: true }).decode(unzipped);
  } catch (err) {
    return fail('', 'invalid_format',
      `Failed to gunzip .iflx bundle: ${err instanceof Error ? err.message : err}`);
  }

  let envelope: IflxEnvelope;
  try {
    envelope = JSON.parse(json) as IflxEnvelope;
  } catch (err) {
    return fail('', 'invalid_format',
      `Invalid JSON envelope: ${err instanceof Error ? err.message : err}`);
  }

  if (envelope.format !== IFLX_MAGIC) {
    return fail('format', 'invalid_format',
      `Unexpected bundle format "${envelope.format}" (expected "${IFLX_MAGIC}").`);
  }
  if (envelope.version !== IFLX_VERSION) {
    return fail('version', 'invalid_format',
      `Unsupported bundle version ${envelope.version}.`);
  }
  if (!envelope.files || typeof envelope.files !== 'object') {
    return fail('files', 'type_mismatch', 'envelope.files must be an object.');
  }

  const entries = Object.entries(envelope.files);
  if (entries.length === 0) {
    return fail('files', 'invalid_format', 'Bundle contains no files.');
  }
  if (entries.length > MAX_PACKED_FILES) {
    return fail('files', 'invalid_format',
      `Bundle contains ${entries.length} files, exceeding limit ${MAX_PACKED_FILES}.`);
  }

  const files = new Map<string, BundleFile>();
  for (const [path, b64] of entries) {
    // Reject path-traversal / absolute keys from an untrusted bundle
    // before they ever reach a host adapter that might write the file
    // map to disk. Keys must be plain relative paths inside the bundle.
    if (!isSafeBundlePath(path)) {
      return fail(`files.${path}`, 'invalid_format',
        `Unsafe bundle file path "${path}" — paths must be relative and contain no ".." segments.`);
    }
    if (typeof b64 !== 'string') {
      return fail(`files.${path}`, 'type_mismatch',
        'Each file entry must be a base64 string.');
    }
    let bytes: Uint8Array;
    try {
      bytes = fromBase64(b64);
    } catch (err) {
      return fail(`files.${path}`, 'invalid_format',
        `Failed to base64-decode ${path}: ${err instanceof Error ? err.message : err}`);
    }
    files.set(path, { path, bytes });
  }

  const manifestFile = files.get('manifest.json');
  if (!manifestFile) {
    return fail('manifest.json', 'required',
      '.iflx bundle is missing manifest.json.');
  }

  return buildBundleFromFiles(files, manifestFile, {
    kind: 'iflx',
  });
}

/**
 * Unpack a .iflx byte string and return both the bundle and any
 * embedded signature block. The signature block is returned RAW —
 * verification (canonical hash recomputation, key import, crypto
 * verify) lives in `signing/verify.ts` and is the caller's
 * responsibility.
 */
export function unpackBundleWithSignature(
  bytes: Uint8Array,
): ValidationResult<UnpackResult> {
  // Re-parse the envelope to pull the signature out. We could refactor
  // unpackBundle to share this path; in practice the dup is small and
  // keeping unpackBundle's signature stable matters more.
  //
  // Both catch blocks below intentionally fall through to the regular
  // unpackBundle for structured error reporting OR to "unsigned"
  // treatment when the bundle is otherwise sound. We DO log warnings
  // so a malformed signature envelope is at least visible in dev
  // tools / CI rather than vanishing.
  let json: string | undefined;
  try {
    const unzipped = gunzipSync(bytes);
    json = new TextDecoder('utf-8', { fatal: true }).decode(unzipped);
  } catch (err) {
    // The shared unpackBundle below will return the structured error.
    // We don't log here — that path will surface the same diagnostic.
    void err;
  }

  const bundleResult = unpackBundle(bytes);
  if (!bundleResult.ok) return bundleResult;

  let signature: SignatureBlock | undefined;
  if (json !== undefined) {
    try {
      const env = JSON.parse(json) as IflxEnvelope;
      if (env.signature) signature = env.signature;
    } catch (err) {
      // The bundle unpacks but the envelope re-parse failed —
      // contradictory, since we just successfully parsed via the
      // shared path. Log to help diagnose corrupted envelopes; treat
      // as unsigned rather than fail-closed (the user explicitly
      // opted into reading an unsigned bundle if they end up here).
      // eslint-disable-next-line no-console
      console.warn(
        '[iflx] Signature envelope re-parse failed; treating bundle as unsigned.',
        err instanceof Error ? err.message : err,
      );
    }
  }

  return {
    ok: true,
    value: {
      bundle: bundleResult.value,
      signature,
    },
  };
}

function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  // Browser fallback.
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Strict base64 — Node's Buffer.from silently ignores invalid chars,
// while browsers' atob throws. We validate first so behaviour is
// consistent across runtimes and corrupted files don't decode
// quietly into garbage.
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * A bundle file key must be a plain relative path contained inside the
 * bundle root. Rejects absolute paths (POSIX `/…` and Windows `C:\…`),
 * any `..` segment, and empty/dot segments — so unpacking can never
 * escape the bundle root if a host adapter writes the file map to disk.
 */
function isSafeBundlePath(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0) return false;
  if (path.startsWith('/') || path.startsWith('\\')) return false;
  if (/^[A-Za-z]:/.test(path)) return false;
  const segments = path.replace(/\\/g, '/').split('/');
  return segments.every((seg) => seg.length > 0 && seg !== '.' && seg !== '..');
}

function fromBase64(b64: string): Uint8Array {
  if (typeof b64 !== 'string') {
    throw new Error('base64 payload must be a string');
  }
  if (b64.length % 4 !== 0 || !BASE64_RE.test(b64)) {
    throw new Error('Invalid base64 payload');
  }
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
  const binary = atob(b64);
  const arr = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) arr[i] = binary.charCodeAt(i);
  return arr;
}

function fail(
  path: string,
  code: import('../types.js').ValidationErrorCode,
  message: string,
): ValidationResult<never> {
  return { ok: false, errors: [{ path, code, message }] };
}

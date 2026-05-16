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

const IFLX_MAGIC = 'iflx';
const IFLX_VERSION = 1;

const MAX_UNCOMPRESSED_BYTES = 8 * 1024 * 1024;
const MAX_PACKED_FILES = 1024;

interface IflxEnvelope {
  format: string;
  version: number;
  files: Record<string, string>;
}

/**
 * Pack a Bundle into a .iflx byte string (gzipped JSON envelope).
 * The resulting bytes are deterministic for a given input.
 */
export function packBundle(bundle: Bundle): Uint8Array {
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

function fromBase64(b64: string): Uint8Array {
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

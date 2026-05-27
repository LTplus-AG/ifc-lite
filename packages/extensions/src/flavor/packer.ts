/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `.iflv` flavor bundle packing and unpacking.
 *
 * A `.iflv` file is a gzipped JSON envelope:
 *
 *   {
 *     "format": "iflv",
 *     "version": 1,
 *     "flavor": Flavor,
 *     "extensionBundles": { "<id>@<version>": "<base64-iflx-bytes>" },
 *     "summary": <human-readable line-by-line>
 *   }
 *
 * `extensionBundles` may be empty when the flavor was exported with
 * `--minimal` (recipient must already have / fetch matching bundle
 * versions). The summary is a non-authoritative display blob —
 * importers always regenerate it from the canonical data on read.
 *
 * Spec: docs/architecture/ai-customization/05-flavors-and-sharing.md §3.
 */

import { gunzipSync, gzipSync } from 'fflate';
import { fromBase64, toBase64 } from '../signing/base64.js';
import type { ValidationError, ValidationResult } from '../types.js';
import { validateFlavor } from './schema.js';
import type { Flavor } from './types.js';

const IFLV_MAGIC = 'iflv';
const IFLV_VERSION = 1;
const MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024; // 64 MiB hard cap

interface IflvEnvelope {
  format: string;
  version: number;
  flavor: Flavor;
  extensionBundles: Record<string, string>;
  summary?: string;
}

export interface FlavorPackOptions {
  /**
   * Map of `<id>@<version>` → raw `.iflx` bytes. Pass an empty Map to
   * produce a "minimal" export that references extensions by id but
   * doesn't include their bundle payloads.
   */
  extensionBundles?: Map<string, Uint8Array>;
  /** Optional human-readable summary to embed. */
  summary?: string;
}

export interface UnpackedFlavor {
  flavor: Flavor;
  /** Same map shape as the pack input; empty for minimal exports. */
  extensionBundles: Map<string, Uint8Array>;
  summary?: string;
}

export function packFlavor(flavor: Flavor, opts: FlavorPackOptions = {}): Uint8Array {
  const extensionBundles: Record<string, string> = {};
  const bundles = opts.extensionBundles ?? new Map();
  // Sort for deterministic output.
  const keys = Array.from(bundles.keys()).sort();
  for (const key of keys) {
    const bytes = bundles.get(key);
    if (!bytes) continue;
    extensionBundles[key] = toBase64(bytes);
  }
  const envelope: IflvEnvelope = {
    format: IFLV_MAGIC,
    version: IFLV_VERSION,
    flavor,
    extensionBundles,
    ...(opts.summary ? { summary: opts.summary } : {}),
  };
  const json = JSON.stringify(envelope);
  // Pin mtime to 0 so the gzip header doesn't embed wall-clock time —
  // two `packFlavor(sameInput)` calls straddling a second boundary
  // would otherwise differ by a few bytes in the MTIME field and the
  // `is deterministic for the same input` test would flake on CI.
  return gzipSync(new TextEncoder().encode(json), { mtime: 0 });
}

export function unpackFlavor(bytes: Uint8Array): ValidationResult<UnpackedFlavor> {
  let json: string;
  try {
    const unzipped = gunzipSync(bytes);
    if (unzipped.byteLength > MAX_UNCOMPRESSED_BYTES) {
      return fail('', 'invalid_format',
        `Flavor uncompressed size ${unzipped.byteLength} exceeds ${MAX_UNCOMPRESSED_BYTES}.`);
    }
    json = new TextDecoder('utf-8', { fatal: true }).decode(unzipped);
  } catch (err) {
    return fail('', 'invalid_format',
      `Failed to gunzip .iflv bundle: ${err instanceof Error ? err.message : err}`);
  }

  let envelope: IflvEnvelope;
  try {
    envelope = JSON.parse(json) as IflvEnvelope;
  } catch (err) {
    return fail('', 'invalid_format',
      `.iflv envelope is not valid JSON: ${err instanceof Error ? err.message : err}`);
  }

  if (envelope.format !== IFLV_MAGIC) {
    return fail('format', 'invalid_format',
      `Unexpected bundle format "${envelope.format}" (expected "${IFLV_MAGIC}").`);
  }
  if (envelope.version !== IFLV_VERSION) {
    return fail('version', 'invalid_format',
      `Unsupported flavor envelope version ${envelope.version}.`);
  }

  // Validate the embedded flavor.
  const flavorResult = validateFlavor(envelope.flavor);
  if (!flavorResult.ok) return flavorResult;

  // Decode bundle blobs.
  const bundles = new Map<string, Uint8Array>();
  if (envelope.extensionBundles && typeof envelope.extensionBundles === 'object') {
    for (const [key, b64] of Object.entries(envelope.extensionBundles)) {
      if (typeof b64 !== 'string') {
        return fail(`extensionBundles.${key}`, 'type_mismatch',
          'Each extension bundle entry must be a base64 string.');
      }
      try {
        bundles.set(key, fromBase64(b64));
      } catch (err) {
        return fail(`extensionBundles.${key}`, 'invalid_format',
          `Failed to base64-decode bundle: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  return {
    ok: true,
    value: {
      flavor: flavorResult.value,
      extensionBundles: bundles,
      summary: typeof envelope.summary === 'string' ? envelope.summary : undefined,
    },
  };
}

function fail(
  path: string,
  code: ValidationError['code'],
  message: string,
): ValidationResult<never> {
  return { ok: false, errors: [{ path, code, message }] };
}

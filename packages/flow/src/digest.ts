/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Content digests for memoisation and tracking.
 *
 * `canonicalJson` sorts object keys and normalises `Map`s so equal values
 * hash equally regardless of insertion order — the same discipline as
 * `diff/fingerprint.ts` and the layer canonicalisation in `@ifc-lite/ifcx`.
 *
 * `trackingGuid` derives the GlobalId of a graph-made element from the
 * node's user-visible tracking key and the lane key only. Nothing
 * session-scoped (model id, run number, graph id) goes in: the identity must
 * survive reloads, exports and layer publishes, or re-runs duplicate
 * elements — the Dynamo element-binding failure this package exists to avoid.
 */

import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { uuidToIfcGuid } from '@ifc-lite/encoding';
import type { FlowData } from './values.js';

const encoder = new TextEncoder();

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return { $num: String(value) };
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value instanceof Map) {
    return { $map: [...value.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, canonicalize(v)]) };
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v !== undefined) out[key] = canonicalize(v);
  }
  return out;
}

/** Deterministic JSON: sorted keys, Maps as sorted entry lists, no undefined. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** blake3 hex of the canonical JSON of any value. */
export function digest(value: unknown): string {
  return bytesToHex(blake3(encoder.encode(canonicalJson(value))));
}

/** Digest of a flow value including its structure. */
export function digestFlowData(data: FlowData): string {
  switch (data.kind) {
    case 'item':
      return digest({ k: 'i', v: data.value });
    case 'list':
      return digest({ k: 'l', v: data.items });
    case 'group':
      return digest({ k: 'g', v: data.branches });
  }
}

/**
 * The GlobalId a tracked output node assigns to the element for `laneKey`.
 * 16 bytes of blake3 over the two keys, rendered as an IFC GUID. Same
 * tracking key + lane key ⇒ same GlobalId on every run, on every host.
 */
export function trackingGuid(trackingKey: string, laneKey: string): string {
  const bytes = blake3(encoder.encode(`${trackingKey}\u0000${laneKey}`), { dkLen: 16 });
  // RFC 4122 version/variant bits so the value is also a well-formed UUID.
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytesToHex(bytes);
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return uuidToIfcGuid(uuid);
}

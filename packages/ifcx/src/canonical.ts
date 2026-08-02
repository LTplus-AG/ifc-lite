/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Canonical serialization and content addressing for published layers.
 *
 * `layerId = blake3(canonical_bytes)` where canonical bytes are produced
 * by:
 *  1. stripping derived (`ifclite::derived`) cache content,
 *  2. sorting all object keys lexicographically and node arrays by path
 *     (stable: same-path opinion order is semantic and preserved),
 *  3. normalizing strings to NFC and numbers to their shortest round-trip
 *     representation, with no insignificant whitespace,
 *  4. including the provenance manifest *except* its `signatures` field
 *     (signatures sign the id, so they cannot be inside it).
 *
 * Spec: docs/architecture/layer-prs/02-layer-format.md §2.4.
 */

import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { IfcxFile, IfcxNode } from './types.js';
import { IFCLITE_ATTR, PROVENANCE_KEY } from './types.js';

const textEncoder = new TextEncoder();

/**
 * Deterministic JSON serialization: lexicographically sorted object keys,
 * NFC-normalized strings, shortest round-trip numbers (JS `JSON.stringify`
 * already emits shortest round-trip for finite doubles), no whitespace.
 */
/**
 * Recursion guard: legitimate IFCX layers nest a handful of levels; a
 * deliberately deep JSON body (which survives `JSON.parse`) must produce a
 * clean error, not a stack-overflow `RangeError` mid-hash.
 */
const MAX_CANONICAL_DEPTH = 512;

export function canonicalStringify(value: unknown, depth = 0): string {
  if (depth > MAX_CANONICAL_DEPTH) {
    throw new Error(`Value nested deeper than ${MAX_CANONICAL_DEPTH} levels is not canonicalizable`);
  }
  if (value === null || value === undefined) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value.normalize('NFC'));
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error(`Non-finite number is not canonicalizable: ${value}`);
      }
      // Normalize negative zero so -0 and 0 hash identically.
      return JSON.stringify(value === 0 ? 0 : value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalStringify(item, depth + 1)).join(',')}]`;
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort();
      const parts = keys.map(
        (key) => `${JSON.stringify(key.normalize('NFC'))}:${canonicalStringify(record[key], depth + 1)}`
      );
      return `{${parts.join(',')}}`;
    }
    default:
      throw new Error(`Value of type ${typeof value} is not canonicalizable`);
  }
}

/**
 * Produce the canonical byte form of a layer document.
 *
 * Derived (cache) content is stripped: nodes flagged `ifclite::derived:
 * true` are dropped entirely, and `ifclite::derived*` attributes are
 * dropped from remaining nodes. The provenance manifest participates in
 * the hash minus its `signatures` field.
 */
export function canonicalizeLayer(file: IfcxFile): Uint8Array {
  const data = file.data
    .filter((node) => node.attributes?.[IFCLITE_ATTR.DERIVED] !== true)
    .map((node) => stripDerivedAttributes(node))
    .map((node) => ({ node, text: canonicalStringify(node) }));

  // Stable sort by path only. The relative order of same-path nodes is
  // semantic (composition applies them in array order, later opinions
  // win), so it must survive into the canonical bytes — two layers whose
  // same-path opinions are ordered differently compose to different
  // states and must hash to different ids.
  data.sort((a, b) => (a.node.path < b.node.path ? -1 : a.node.path > b.node.path ? 1 : 0));

  const header: Record<string, unknown> = { ...file.header };
  // header.id is where tools record the content address itself — it is
  // self-referential and excluded, so `computeLayerId(file)` can be
  // verified against `file.header.id` after publishing.
  delete header.id;
  const manifest = header[PROVENANCE_KEY];
  if (manifest && typeof manifest === 'object') {
    const cleaned: Record<string, unknown> = { ...(manifest as Record<string, unknown>) };
    delete cleaned.signatures;
    header[PROVENANCE_KEY] = cleaned;
  }

  const canonical =
    `{"data":[${data.map((entry) => entry.text).join(',')}],` +
    `"header":${canonicalStringify(header)},` +
    `"imports":${canonicalStringify(file.imports)},` +
    `"schemas":${canonicalStringify(file.schemas)}}`;

  return textEncoder.encode(canonical);
}

function stripDerivedAttributes(node: IfcxNode): IfcxNode {
  if (!node.attributes) return node;
  const hasDerived = Object.keys(node.attributes).some((key) =>
    key.startsWith(IFCLITE_ATTR.DERIVED)
  );
  if (!hasDerived) return node;
  const attributes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node.attributes)) {
    if (key.startsWith(IFCLITE_ATTR.DERIVED)) continue;
    attributes[key] = value;
  }
  const out: IfcxNode = { path: node.path };
  if (node.children) out.children = node.children;
  if (node.inherits) out.inherits = node.inherits;
  if (Object.keys(attributes).length > 0) out.attributes = attributes;
  return out;
}

/** Content-address a published layer: `blake3:<hex>` over canonical bytes. */
export function computeLayerId(file: IfcxFile): string {
  return `blake3:${bytesToHex(blake3(canonicalizeLayer(file)))}`;
}

/**
 * A stack hash is blake3 over the ordered list of layer ids — the identity
 * of a composed state. Refs (`main`, `design-option-B`) are named mutable
 * pointers to stack hashes.
 */
export function computeStackHash(layerIds: readonly string[]): string {
  const joined = layerIds.join('\n');
  return `blake3:${bytesToHex(blake3(textEncoder.encode(joined)))}`;
}

/** blake3 digest helper for related artifacts (instruction texts, reports). */
export function blake3Digest(content: string | Uint8Array): string {
  const bytes = typeof content === 'string' ? textEncoder.encode(content.normalize('NFC')) : content;
  return `blake3:${bytesToHex(blake3(bytes))}`;
}

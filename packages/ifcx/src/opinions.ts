/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Opinion retention for federated composition.
 *
 * Stack order picks ONE value per attribute and discards the rest, so two
 * layers that disagree (architect EI 60, fire consultant EI 90) compose
 * without anyone seeing the disagreement. With `retainOpinions`, every
 * layer's own value is kept per (path, attribute key), in precedence order
 * with the strongest LAST — the same shape as the buildingSMART reference
 * `GetOpinions` (IFC5-development PR #153), whose last entry is the
 * composed value.
 *
 * Only a node's OWN opinions are retained; values reached through
 * `inherits` belong to the inherited node and are retained there. One
 * opinion per layer: when a layer carries several nodes for one path, the
 * layer's last value is its opinion (that is what the layer composes to).
 * A `null` value is a removal opinion and is retained like any other.
 * The `ifclite::deleted` tombstone marker is not retained: composition
 * strips it from every surviving node, and a tombstoned node takes its
 * opinions with it.
 *
 * Spec: docs/architecture/layer-prs/12-authority.md §12.4.
 */

import type { IfcxLayer } from './layer-stack.js';
import { getProvenance } from './provenance.js';
import { IFCLITE_ATTR } from './types.js';

/** One layer's own value for one attribute of one path. */
export interface AttributeOpinion {
  layerId: string;
  layerName: string;
  /** `author.principal` from the layer's provenance manifest, when it is a string. */
  principal?: string;
  /** The layer's value; `null` is a removal opinion. */
  value: unknown;
}

/** Attribute key → opinions, weakest first, strongest last. */
export type AttributeOpinions = Map<string, AttributeOpinion[]>;

/** An attribute whose layers hold more than one distinct value. */
export interface DivergentAttribute {
  path: string;
  attribute: string;
  /** All opinions, weakest first, strongest last (the composed one). */
  opinions: AttributeOpinion[];
}

/**
 * Record one layer's own attribute values for a path. Call once per layer,
 * weakest layer first, with that layer's nodes for the path.
 */
export function recordLayerOpinions(
  into: AttributeOpinions,
  layer: IfcxLayer,
  layerValues: ReadonlyMap<string, unknown>
): void {
  if (layerValues.size === 0) return;
  // The header is unvalidated input: keep any string as written (an empty
  // principal is still a stated one, distinct from no manifest), drop the rest.
  const stated: unknown = getProvenance(layer.file)?.author?.principal;
  const principal = typeof stated === 'string' ? stated : undefined;
  for (const [attribute, value] of layerValues) {
    if (attribute === IFCLITE_ATTR.DELETED) continue;
    const opinion: AttributeOpinion = { layerId: layer.id, layerName: layer.name, value };
    if (principal !== undefined) opinion.principal = principal;
    const list = into.get(attribute);
    if (list) list.push(opinion);
    else into.set(attribute, [opinion]);
  }
}

/** Same nesting cap as `canonicalStringify`; also stops cyclic values. */
const MAX_KEY_DEPTH = 512;
/** Identity keys for values past the cap: distinct values differ, one reference agrees. */
const deepValueKeys = new WeakMap<object, string>();
let deepValueCount = 0;

/**
 * Comparison key for an opinion value. Identical to `canonicalStringify`
 * for every value it accepts (NFC strings, -0 as 0, sorted keys, object
 * members holding `undefined` skipped), and total for the rest: a
 * top-level `undefined` (an in-memory layer keeping the attribute) is
 * distinct from a `null` removal, and values JSON cannot carry (non-finite
 * numbers such as a parsed `1e400`, bigint, functions, symbols) get tagged
 * keys. A value nested past `MAX_KEY_DEPTH` (or cyclic) compares by
 * identity instead, so nothing throws.
 */
function opinionKey(value: unknown): string {
  const key = structuralKey(value, 0);
  if (key !== undefined) return key;
  const target = value as object;
  let identity = deepValueKeys.get(target);
  if (identity === undefined) {
    identity = `\u0000deep:${deepValueCount++}`;
    deepValueKeys.set(target, identity);
  }
  return identity;
}

/** Canonical key, or undefined when the value nests past `MAX_KEY_DEPTH`. */
function structuralKey(value: unknown, depth: number): string | undefined {
  if (value === undefined && depth === 0) return '\u0000undefined';
  if (value === null || value === undefined) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value.normalize('NFC'));
    case 'number':
      if (!Number.isFinite(value)) return `\u0000number:${value}`;
      return JSON.stringify(value === 0 ? 0 : value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'object': {
      if (depth >= MAX_KEY_DEPTH) return undefined;
      const parts: string[] = [];
      if (Array.isArray(value)) {
        for (const item of value) {
          const part = structuralKey(item, depth + 1);
          if (part === undefined) return undefined;
          parts.push(part);
        }
        return `[${parts.join(',')}]`;
      }
      const record = value as Record<string, unknown>;
      // Sort by the NFC form, so two spellings of one key order the same;
      // the raw key breaks ties when one object holds both spellings.
      const members = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .map((key) => [key.normalize('NFC'), key] as const)
        .sort(([a, rawA], [b, rawB]) => (a !== b ? (a < b ? -1 : 1) : rawA < rawB ? -1 : rawA > rawB ? 1 : 0));
      for (const [nfc, key] of members) {
        const part = structuralKey(record[key], depth + 1);
        if (part === undefined) return undefined;
        parts.push(`${JSON.stringify(nfc)}:${part}`);
      }
      return `{${parts.join(',')}}`;
    }
    default:
      return `\u0000${typeof value}:${String(value)}`;
  }
}

/**
 * Attributes whose retained opinions hold more than one distinct value.
 * Values are compared canonically (key order does not matter), never by
 * layer or principal: two layers holding the same value agree.
 *
 * Results are sorted by path, then attribute, so the output is
 * deterministic for a given stack.
 */
export function findDivergentAttributes(
  opinionsByPath: ReadonlyMap<string, ReadonlyMap<string, readonly AttributeOpinion[]>>
): DivergentAttribute[] {
  const divergent: DivergentAttribute[] = [];
  for (const [path, byAttribute] of opinionsByPath) {
    for (const [attribute, opinions] of byAttribute) {
      if (opinions.length < 2) continue;
      const first = opinionKey(opinions[0].value);
      const differs = opinions.some((o) => opinionKey(o.value) !== first);
      if (differs) divergent.push({ path, attribute, opinions: [...opinions] });
    }
  }
  return divergent.sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : a.attribute < b.attribute ? -1 : a.attribute > b.attribute ? 1 : 0
  );
}

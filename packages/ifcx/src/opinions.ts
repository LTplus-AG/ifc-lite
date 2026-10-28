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
import { canonicalStringify } from './canonical.js';
import { getProvenance } from './provenance.js';
import { IFCLITE_ATTR } from './types.js';

/** One layer's own value for one attribute of one path. */
export interface AttributeOpinion {
  layerId: string;
  layerName: string;
  /** `author.principal` from the layer's provenance manifest, when present. */
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
  const principal = getProvenance(layer.file)?.author?.principal;
  for (const [attribute, value] of layerValues) {
    if (attribute === IFCLITE_ATTR.DELETED) continue;
    const opinion: AttributeOpinion = { layerId: layer.id, layerName: layer.name, value };
    if (principal) opinion.principal = principal;
    const list = into.get(attribute);
    if (list) list.push(opinion);
    else into.set(attribute, [opinion]);
  }
}

/**
 * Comparison key for an opinion value. Canonical for every IFCX value;
 * values `canonicalStringify` rejects (non-finite numbers, functions,
 * nesting past its depth limit) cannot come from a parsed file, so they
 * fall back to identity (`Object.is`) instead of throwing.
 */
function opinionKey(value: unknown, fallback: Map<unknown, string>): string {
  try {
    return canonicalStringify(value ?? null);
  } catch {
    let key = fallback.get(value);
    if (key === undefined) {
      key = `\u0000uncanonical:${fallback.size}`;
      fallback.set(value, key);
    }
    return key;
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
      const fallback = new Map<unknown, string>();
      const first = opinionKey(opinions[0].value, fallback);
      const differs = opinions.some((o) => opinionKey(o.value, fallback) !== first);
      if (differs) divergent.push({ path, attribute, opinions: [...opinions] });
    }
  }
  return divergent.sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : a.attribute < b.attribute ? -1 : a.attribute > b.attribute ? 1 : 0
  );
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Inverted property-value index for applicability filtering.
 *
 * Code-list IDS packs are hundreds of specifications that differ only
 * in one property literal (e.g. `Pset_CodeList.04 CommonName == "X"`).
 * Evaluating those per entity per specification is O(specs × entities ×
 * psets); semantically the whole pack is ONE group-by over
 * (pset, prop) → value → entityIds. This index materialises exactly
 * that, restricted to the (pset, prop) keys the document actually uses.
 *
 * Correctness model: lookups return a candidate SUPERSET, never a final
 * verdict — the validator confirms every candidate with the boolean
 * facet core afterwards. The index may therefore be conservative (the
 * `hasProp` fallback) wherever exact-value bucketing can't mirror
 * matchConstraint semantics (numeric/boolean-coercible literals,
 * pattern/bounds constraints, existence checks).
 */

import type {
  IDSDocument,
  IDSPropertyFacet,
  IFCDataAccessor,
} from '../types.js';
import {
  isStrictNumericLiteral,
  isBooleanLiteral,
} from '../constraints/comparators.js';

const KEY_SEP = '\u0000';

function isCoercible(literal: string): boolean {
  return isStrictNumericLiteral(literal) || isBooleanLiteral(literal);
}

/** Indexable = simpleValue pset + baseName whose literals can only
 * match by exact string equality (non-coercible names). */
function indexKeyFor(facet: IDSPropertyFacet): string | undefined {
  if (facet.propertySet.type !== 'simpleValue') return undefined;
  if (facet.baseName.type !== 'simpleValue') return undefined;
  if (isCoercible(facet.propertySet.value) || isCoercible(facet.baseName.value)) {
    return undefined;
  }
  return facet.propertySet.value + KEY_SEP + facet.baseName.value;
}

export class ApplicabilityPropertyIndex {
  /** (pset␀prop) keys the document's applicability facets need. */
  private readonly keys = new Set<string>();
  /** Entities already folded into the buckets. */
  private readonly indexed = new Set<number>();
  /** key → entityIds that carry the property at all (any value). */
  private readonly hasProp = new Map<string, Set<number>>();
  /** key → value string → entityIds. */
  private readonly byValue = new Map<string, Map<string, Set<number>>>();

  constructor(
    private readonly accessor: IFCDataAccessor,
    document: IDSDocument
  ) {
    for (const spec of document.specifications) {
      for (const facet of spec.applicability.facets) {
        if (facet.type !== 'property') continue;
        const key = indexKeyFor(facet);
        if (key !== undefined) this.keys.add(key);
      }
    }
  }

  /**
   * Fold the given entities into the index (each entity at most once
   * per run). Cost is one cached-pset walk per new entity — the same
   * walk a single per-entity facet check pays today.
   */
  private async ensureIndexed(
    entityIds: number[],
    maybeYield: () => Promise<void> | undefined,
    onScanProgress?: (processed: number, total: number) => void
  ): Promise<void> {
    if (this.keys.size === 0) return;
    // Only the first fold-in over a large candidate set does real work
    // (cold property extraction); count how many are actually new so the
    // progress reporter reflects the entities being scanned, not cache
    // hits.
    let newCount = 0;
    for (let i = 0; i < entityIds.length; i++) {
      const id = entityIds[i];
      if (this.indexed.has(id)) continue;
      this.indexed.add(id);
      newCount++;
      // The first fold-in over a large candidate set is real CPU work
      // (pset extraction per entity) — keep the host UI painting and
      // report granular progress, since this is the slowest phase of a
      // large validation run.
      if ((newCount & 511) === 0) {
        onScanProgress?.(i + 1, entityIds.length);
        await maybeYield();
      }

      const psets = this.accessor.getPropertySets(id);
      for (const pset of psets) {
        for (const prop of pset.properties) {
          const key = pset.name + KEY_SEP + prop.name;
          if (!this.keys.has(key)) continue;

          let has = this.hasProp.get(key);
          if (!has) {
            has = new Set();
            this.hasProp.set(key, has);
          }
          has.add(id);

          const candidateValues =
            prop.values && prop.values.length > 0 ? prop.values : [prop.value];
          let valueMap = this.byValue.get(key);
          if (!valueMap) {
            valueMap = new Map();
            this.byValue.set(key, valueMap);
          }
          for (const v of candidateValues) {
            if (v === null || v === undefined || v === '') continue;
            const valueKey = String(v);
            let bucket = valueMap.get(valueKey);
            if (!bucket) {
              bucket = new Set();
              valueMap.set(valueKey, bucket);
            }
            bucket.add(id);
          }
        }
      }
    }
  }

  /**
   * Narrow `candidates` to a superset of the entities that can pass
   * `facet`. Returns undefined when the facet isn't indexable — the
   * caller keeps the full candidate list.
   */
  async narrow(
    facet: IDSPropertyFacet,
    candidates: number[],
    maybeYield: () => Promise<void> | undefined,
    onScanProgress?: (processed: number, total: number) => void
  ): Promise<number[] | undefined> {
    const key = indexKeyFor(facet);
    if (key === undefined || !this.keys.has(key)) return undefined;

    await this.ensureIndexed(candidates, maybeYield, onScanProgress);

    const value = facet.value;
    let superset: Set<number> | undefined;

    if (value && value.type === 'simpleValue' && !isCoercible(value.value)) {
      // Exact-string bucket. Coercible literals ('42', 'true') can also
      // match stored values via numeric/boolean comparison, so they get
      // the conservative hasProp superset below instead.
      superset = this.byValue.get(key)?.get(value.value) ?? new Set();
    } else if (
      value &&
      value.type === 'enumeration' &&
      !value.values.some(isCoercible)
    ) {
      const valueMap = this.byValue.get(key);
      superset = new Set();
      if (valueMap) {
        for (const v of value.values) {
          const bucket = valueMap.get(v);
          if (bucket) for (const id of bucket) superset.add(id);
        }
      }
    } else {
      // Existence check, dataType-only, pattern/bounds values, or
      // coercible literals: any entity carrying the property at all.
      superset = this.hasProp.get(key) ?? new Set();
    }

    if (superset.size === 0) return [];
    return candidates.filter((id) => superset!.has(id));
  }
}

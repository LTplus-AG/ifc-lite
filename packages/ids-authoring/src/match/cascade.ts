/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The node matcher shared by re-identification and the semantic diff
 * (02-document-model-and-ops.md §2 and §6: "shared with diff").
 *
 * Within one Studio lineage (two revisions of one document) nodes match by
 * node id only. Otherwise specifications match by, in order: the same
 * non-empty `identifier`;
 * the same name and applicability signature; then the best similarity over
 * name tokens and facet signatures above a threshold. Facets match within a
 * section by: identical content; the same
 * type and key (pset + property, entity name, …); then key similarity.
 * Every step is one-to-one and greedy by score.
 */

import type { IDSConstraint, IDSFacet, IDSSpecification } from '@ifc-lite/ids';
import { similarity } from '../gate/rank.js';

export type MatchStep = 'nodeId' | 'identifier' | 'signature' | 'similarity';
export type FacetMatchStep = 'nodeId' | 'exact' | 'key' | 'similar';

/** Default minimum similarity for the last cascade step (0..1). */
export const DEFAULT_MATCH_THRESHOLD = 0.55;

function constraintKey(c: IDSConstraint | undefined): string {
  if (!c) return '';
  switch (c.type) {
    case 'simpleValue':
      return c.value.toUpperCase();
    case 'enumeration':
      return [...c.values].sort().join('|').toUpperCase();
    case 'pattern':
      return `/${c.pattern}/`;
    case 'bounds':
      return 'bounds';
  }
}

/** What a facet is "about": stable across value edits. */
export function facetKey(f: IDSFacet): string {
  switch (f.type) {
    case 'entity':
      return `entity:${constraintKey(f.name)}`;
    case 'attribute':
      return `attribute:${constraintKey(f.name)}`;
    case 'property':
      return `property:${constraintKey(f.propertySet)}.${constraintKey(f.baseName)}`;
    case 'classification':
      return `classification:${constraintKey(f.system)}`;
    case 'material':
      return 'material';
    case 'partOf':
      return `partOf:${f.relation}:${constraintKey(f.entity?.name)}`;
  }
}

/** Canonical JSON-like rendering: sorted keys, `undefined` dropped. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${k}:${canonical(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function applicabilitySignature(s: IDSSpecification): string {
  return s.applicability.facets.map(canonical).sort().join(';');
}

function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (!sa.size && !sb.size) return 1;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / (sa.size + sb.size - inter);
}

function specSimilarity(a: IDSSpecification, b: IDSSpecification): number {
  const keys = (s: IDSSpecification) => [...s.applicability.facets, ...s.requirements.map((r) => r.facet)].map(facetKey);
  return 0.4 * similarity(a.name, b.name) + 0.6 * jaccard(keys(a), keys(b));
}

/** Result of a cascade: next index → matched previous index and the step that matched it. */
export interface Pairing<S extends string> {
  pairs: Map<number, { prev: number; by: S }>;
  usedPrev: Set<number>;
}

/**
 * Greedy one-to-one matching over the cascade. `steps` are tried in order;
 * each returns a score (> 0 means a candidate pair) for unmatched pairs.
 * `seed` pre-assigns pairs (e.g. matched by node id elsewhere).
 */
export function cascade<A, B, S extends string>(
  prev: readonly A[],
  next: readonly B[],
  steps: [S, (a: A, b: B) => number][],
  seed?: Pairing<S>,
): Pairing<S> {
  const pairs = new Map(seed?.pairs);
  const usedPrev = new Set(seed?.usedPrev);
  for (const [by, score] of steps) {
    const candidates: { p: number; n: number; s: number }[] = [];
    next.forEach((b, n) => {
      if (pairs.has(n)) return;
      prev.forEach((a, p) => {
        if (usedPrev.has(p)) return;
        const s = score(a, b);
        if (s > 0) candidates.push({ p, n, s });
      });
    });
    // Best score first; ties keep document order (stable for duplicates).
    candidates.sort((x, y) => y.s - x.s || Math.abs(x.p - x.n) - Math.abs(y.p - y.n) || x.n - y.n);
    for (const c of candidates) {
      if (pairs.has(c.n) || usedPrev.has(c.p)) continue;
      pairs.set(c.n, { prev: c.p, by });
      usedPrev.add(c.p);
    }
  }
  return { pairs, usedPrev };
}

export interface MatchOptions {
  /** Minimum similarity for the last cascade step (0..1). */
  threshold?: number;
  /** Match identical `id`s first (both sides share one Studio lineage). */
  byNodeId?: boolean;
}

/** Pair specifications of `next` with those of `prev`. */
export function matchSpecs(
  prev: readonly IDSSpecification[],
  next: readonly IDSSpecification[],
  options: MatchOptions = {},
): Pairing<MatchStep> {
  const threshold = options.threshold ?? DEFAULT_MATCH_THRESHOLD;
  const steps: [MatchStep, (a: IDSSpecification, b: IDSSpecification) => number][] = [
    ['identifier', (a, b) => (a.identifier && a.identifier === b.identifier ? 1 : 0)],
    ['signature', (a, b) => (a.name === b.name && applicabilitySignature(a) === applicabilitySignature(b) ? 1 : 0)],
    ['similarity', (a, b) => {
      const s = specSimilarity(a, b);
      return s >= threshold ? s : 0;
    }],
  ];
  // Within one lineage node ids are the truth: a node with a new id is a
  // new node, even when it resembles a removed one.
  if (options.byNodeId) return cascade(prev, next, [['nodeId', (a, b) => (a.id === b.id ? 1 : 0)]]);
  return cascade(prev, next, steps);
}

/**
 * Pair facets of one section. `seed` carries pairs already decided
 * elsewhere (by node id); the cascade only fills in the rest.
 */
export function matchFacetList(
  prev: readonly IDSFacet[],
  next: readonly IDSFacet[],
  options: { threshold?: number; seed?: Pairing<FacetMatchStep> } = {},
): Pairing<FacetMatchStep> {
  const threshold = options.threshold ?? DEFAULT_MATCH_THRESHOLD;
  return cascade<IDSFacet, IDSFacet, FacetMatchStep>(
    prev,
    next,
    [
      ['exact', (a, b) => (canonical(a) === canonical(b) ? 1 : 0)],
      ['key', (a, b) => (a.type === b.type && facetKey(a) === facetKey(b) ? 1 : 0)],
      ['similar', (a, b) => {
        if (a.type !== b.type) return 0;
        const s = similarity(facetKey(a), facetKey(b));
        return s >= threshold ? s : 0;
      }],
    ],
    options.seed,
  );
}

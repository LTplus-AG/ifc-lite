/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Re-identification (§2, §6): when an external IDS is imported over an
 * existing Studio document (a client sends v2), give each incoming node
 * the id of the node it continues, so comments, provenance and history
 * survive.
 *
 * Specifications match by, in order: the same non-empty `identifier`; the
 * same name and applicability signature; then the best similarity over
 * name tokens and facet signatures, above a threshold. Facets match within
 * a matched spec and section by: identical facet; same type and key (pset
 * + property, entity name, …); then key similarity. Every cascade step is
 * one-to-one and greedy by score. Unmatched incoming nodes get fresh ids;
 * unmatched previous nodes are reported as removed.
 */

import type { IDSConstraint, IDSDocument, IDSFacet, IDSSpecification } from '@ifc-lite/ids';
import { presentFields, type FacetFieldName } from '../document/fields.js';
import { mintFacetNodes } from '../document/from-ids.js';
import type { FacetNodes, SpecNodes, StudioDocument } from '../document/types.js';
import { similarity } from '../gate/rank.js';
import { uuidv7, type Uuid } from '../uuid.js';

export type MatchStep = 'identifier' | 'signature' | 'similarity';

export interface ReidentifyReport {
  specs: { matched: { index: number; id: Uuid; by: MatchStep }[]; added: number[]; removed: Uuid[] };
  facets: { matched: number; added: number; removed: number };
}

export interface ReidentifyOptions {
  newId?: () => Uuid;
  /** Minimum similarity for the last cascade step (0..1). */
  threshold?: number;
}

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
function facetKey(f: IDSFacet): string {
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

function canonical(value: unknown): string {
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

/**
 * Greedy one-to-one matching over the cascade. `steps` are tried in order;
 * each returns a score (> 0 means a candidate pair) for unmatched pairs.
 */
function cascade<A, B, S extends string>(
  prev: A[],
  next: B[],
  steps: [S, (a: A, b: B) => number][],
): { pairs: Map<number, { prev: number; by: S }>; usedPrev: Set<number> } {
  const pairs = new Map<number, { prev: number; by: S }>();
  const usedPrev = new Set<number>();
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

function matchFacets(
  prev: { facet: IDSFacet; nodes: FacetNodes }[],
  next: IDSFacet[],
  threshold: number,
  newId: () => Uuid,
  report: ReidentifyReport,
): FacetNodes[] {
  const { pairs, usedPrev } = cascade(prev, next, [
    ['exact', (a, b) => (canonical(a.facet) === canonical(b) ? 1 : 0)],
    ['key', (a, b) => (a.facet.type === b.type && facetKey(a.facet) === facetKey(b) ? 1 : 0)],
    ['similar', (a, b) => {
      if (a.facet.type !== b.type) return 0;
      const s = similarity(facetKey(a.facet), facetKey(b));
      return s >= threshold ? s : 0;
    }],
  ]);
  report.facets.matched += pairs.size;
  report.facets.added += next.length - pairs.size;
  report.facets.removed += prev.length - usedPrev.size;
  return next.map((facet, n) => {
    const hit = pairs.get(n);
    if (!hit) return mintFacetNodes(facet, newId);
    const old = prev[hit.prev].nodes;
    const constraints: Partial<Record<FacetFieldName, Uuid>> = {};
    for (const field of presentFields(facet)) constraints[field] = old.constraints[field] ?? newId();
    return { id: old.id, constraints };
  });
}

/** Rebind `incoming` onto the node ids of `previous`. Meta and docId are kept. */
export function reidentify(
  previous: StudioDocument,
  incoming: IDSDocument,
  options: ReidentifyOptions = {},
): { doc: StudioDocument; report: ReidentifyReport } {
  const newId = options.newId ?? (() => uuidv7());
  const threshold = options.threshold ?? 0.55;
  const prevSpecs = previous.ids.specifications;
  const report: ReidentifyReport = { specs: { matched: [], added: [], removed: [] }, facets: { matched: 0, added: 0, removed: 0 } };
  const { pairs, usedPrev } = cascade<IDSSpecification, IDSSpecification, MatchStep>(prevSpecs, incoming.specifications, [
    ['identifier', (a, b) => (a.identifier && a.identifier === b.identifier ? 1 : 0)],
    ['signature', (a, b) => (a.name === b.name && applicabilitySignature(a) === applicabilitySignature(b) ? 1 : 0)],
    ['similarity', (a, b) => {
      const s = specSimilarity(a, b);
      return s >= threshold ? s : 0;
    }],
  ]);
  const specs: IDSSpecification[] = [];
  const nodes: SpecNodes[] = [];
  incoming.specifications.forEach((spec, n) => {
    const hit = pairs.get(n);
    const prevNodes = hit ? previous.nodes.specs[hit.prev] : undefined;
    const prevSpec = hit ? prevSpecs[hit.prev] : undefined;
    const specId = prevNodes?.id ?? newId();
    if (hit) report.specs.matched.push({ index: n, id: specId, by: hit.by });
    else report.specs.added.push(n);
    const items = (section: 'applicability' | 'requirements') =>
      prevSpec && prevNodes
        ? section === 'applicability'
          ? prevSpec.applicability.facets.map((facet, j) => ({ facet, nodes: prevNodes.applicability[j] }))
          : prevSpec.requirements.map((r, j) => ({ facet: r.facet, nodes: prevNodes.requirements[j] }))
        : [];
    const applicability = matchFacets(items('applicability'), spec.applicability.facets, threshold, newId, report);
    const requirements = matchFacets(items('requirements'), spec.requirements.map((r) => r.facet), threshold, newId, report);
    specs.push({ ...spec, id: specId, requirements: spec.requirements.map((r, j) => ({ ...r, id: requirements[j].id })) });
    nodes.push({ id: specId, applicability, requirements });
  });
  prevSpecs.forEach((s, p) => {
    if (usedPrev.has(p)) return;
    report.specs.removed.push(s.id);
    report.facets.removed += s.applicability.facets.length + s.requirements.length;
  });
  return {
    doc: {
      ...previous,
      ids: { ...incoming, specifications: specs },
      nodes: { document: previous.nodes.document, specs: nodes },
    },
    report,
  };
}

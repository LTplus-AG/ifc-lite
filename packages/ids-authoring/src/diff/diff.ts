/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `diffDocuments(a, b)`: the semantic diff (02-document-model-and-ops.md
 * §6). Nodes are paired with the matcher shared with re-identification;
 * paired nodes are compared field by field; unpaired ones are added or
 * removed. Reorders are reported only for nodes off the longest run that
 * kept its relative order, so moving one specification to the top reports
 * one move, not N.
 */

import type { Section, StudioDocument } from '../document/types.js';
import type { Uuid } from '../uuid.js';
import { align, facetSites, longestIncreasing, SECTIONS, type Alignment, type FacetSite } from './align.js';
import { customEntries, facetEntries, infoEntries, requirementOf, snapshot, specEntries } from './compare.js';
import type { DiffEntry, DiffOptions, DiffOrder, DocumentDiff, FacetAlignment, FacetContext, SpecAlignment } from './types.js';

interface Walk {
  a: StudioDocument;
  b: StudioDocument;
  al: Alignment;
  entries: DiffEntry[];
  order: DiffOrder;
}

/** Id of a `b` spec in the patched document's id space. */
function targetSpecId(w: Walk, n: number): Uuid {
  const pair = w.al.specs.pairs.get(n);
  return pair ? w.a.ids.specifications[pair.prev].id : w.b.ids.specifications[n].id;
}

function context(w: Walk, n: number, site: FacetSite, matched: FacetSite | undefined): FacetContext {
  const spec = w.b.ids.specifications[n];
  const req = requirementOf(w.b, site);
  return {
    specId: targetSpecId(w, n),
    specName: spec.name,
    section: site.section,
    facetId: matched?.nodes.id ?? site.nodes.id,
    facet: site.facet,
    ...(req ? { optionality: req.optionality } : {}),
  };
}

/** Facet rows and entries of `b` spec `n` in `section`. */
function walkSection(w: Walk, n: number, section: Section, rows: FacetAlignment[], specAdded: boolean): Uuid[] {
  const sites = facetSites(w.b, n, section);
  const tSpec = targetSpecId(w, n);
  const pair = w.al.specs.pairs.get(n);
  // In-section reorders: LIS over the `a` indices of facets that stayed in
  // this (matched) spec and section.
  const stayed: { bIndex: number; aIndex: number }[] = [];
  for (const site of sites) {
    const hit = w.al.facets.get(site.nodes.id);
    if (hit && pair && hit.a.specIndex === pair.prev && hit.a.section === section) {
      stayed.push({ bIndex: site.index, aIndex: hit.a.index });
    }
  }
  const keep = longestIncreasing(stayed.map((s) => s.aIndex));
  const kept = new Set(stayed.filter((_, i) => keep.has(i)).map((s) => s.bIndex));
  const order: Uuid[] = [];
  for (const site of sites) {
    const hit = w.al.facets.get(site.nodes.id);
    const ctx = context(w, n, site, hit?.a);
    const bRow = { specId: tSpec, section, index: site.index, facetId: site.nodes.id };
    if (!hit) {
      order.push(site.nodes.id);
      rows.push({ b: bRow, status: 'added' });
      if (!specAdded) {
        const requirement = snapshot(requirementOf(w.b, site));
        w.entries.push({ ...ctx, kind: 'facet.added', index: site.index, nodes: site.nodes, ...(requirement ? { requirement } : {}) });
      }
      continue;
    }
    order.push(hit.a.nodes.id);
    const crossed = !pair || hit.a.specIndex !== pair.prev || hit.a.section !== section;
    const moved = crossed || !kept.has(site.index);
    const changes = facetEntries(ctx, hit.a, site, requirementOf(w.a, hit.a), requirementOf(w.b, site));
    if (moved) {
      w.entries.push({
        ...ctx,
        kind: 'facet.moved',
        from: { specId: hit.a.specId, section: hit.a.section, index: hit.a.index },
        to: { specId: tSpec, section, index: site.index },
      });
    }
    w.entries.push(...changes);
    rows.push({
      a: { specId: hit.a.specId, section: hit.a.section, index: hit.a.index, facetId: hit.a.nodes.id },
      b: bRow,
      by: hit.by,
      status: moved ? 'moved' : changes.length ? 'changed' : 'unchanged',
    });
  }
  // Facets of the matched `a` spec section that nothing continues.
  if (pair) {
    for (const site of facetSites(w.a, pair.prev, section)) {
      if (w.al.usedA.has(site.nodes.id)) continue;
      const spec = w.b.ids.specifications[n];
      const req = requirementOf(w.a, site);
      w.entries.push({
        kind: 'facet.removed',
        specId: tSpec,
        specName: spec.name,
        section,
        facetId: site.nodes.id,
        facet: site.facet,
        index: site.index,
        ...(req ? { optionality: req.optionality } : {}),
      });
      rows.push({ a: { specId: site.specId, section, index: site.index, facetId: site.nodes.id }, status: 'removed' });
    }
  }
  return order;
}

/** Compute the semantic diff from `a` to `b`. */
export function diffDocuments(a: StudioDocument, b: StudioDocument, options: DiffOptions = {}): DocumentDiff {
  const byNodeId = options.byNodeId ?? a.docId === b.docId;
  const al = align(a, b, byNodeId, options.threshold);
  const w: Walk = { a, b, al, entries: [...infoEntries(a.ids, b.ids), ...customEntries(a, b)], order: { specs: [], sections: {} } };
  const specs: SpecAlignment[] = [];
  const pairs = b.ids.specifications.map((_, n) => ({ n, prev: al.specs.pairs.get(n)?.prev }));
  const matched = pairs.filter((p): p is { n: number; prev: number } => p.prev !== undefined);
  const keep = longestIncreasing(matched.map((p) => p.prev));
  const kept = new Set(matched.filter((_, i) => keep.has(i)).map((p) => p.n));
  b.ids.specifications.forEach((spec, n) => {
    const pair = al.specs.pairs.get(n);
    const tSpec = targetSpecId(w, n);
    w.order.specs.push(tSpec);
    const before = w.entries.length;
    const rows: FacetAlignment[] = [];
    if (!pair) {
      w.entries.push({ kind: 'spec.added', specId: spec.id, specName: spec.name, index: n, spec, nodes: b.nodes.specs[n] });
    } else {
      const old = a.ids.specifications[pair.prev];
      if (!kept.has(n)) w.entries.push({ kind: 'spec.moved', specId: old.id, specName: spec.name, from: pair.prev, to: n });
      w.entries.push(...specEntries(old, spec));
    }
    const sections = { applicability: [] as Uuid[], requirements: [] as Uuid[] };
    for (const section of SECTIONS) sections[section] = walkSection(w, n, section, rows, !pair);
    w.order.sections[tSpec] = sections;
    const old = pair ? a.ids.specifications[pair.prev] : undefined;
    specs.push({
      ...(old && pair ? { a: { index: pair.prev, specId: old.id, name: old.name }, by: pair.by } : {}),
      b: { index: n, specId: tSpec, name: spec.name },
      status: !pair ? 'added' : !kept.has(n) ? 'moved' : w.entries.length > before ? 'changed' : 'unchanged',
      facets: rows,
    });
  });
  a.ids.specifications.forEach((spec, p) => {
    if (al.specs.usedPrev.has(p)) return;
    w.entries.push({ kind: 'spec.removed', specId: spec.id, specName: spec.name, index: p });
    specs.push({ a: { index: p, specId: spec.id, name: spec.name }, status: 'removed', facets: [] });
  });
  return { identical: w.entries.length === 0, byNodeId, entries: w.entries, specs, order: w.order };
}

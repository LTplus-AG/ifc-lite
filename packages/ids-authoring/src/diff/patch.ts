/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `diffToOps(a, diff)`: the primitive ops that turn `a` into the `b` the
 * diff was computed against. Built from the diff entries alone (plus the
 * target order), so a diff that missed a change produces a patch that
 * misses it too; the tests use that as the diff's completeness oracle.
 *
 * Phases, chosen so every op is valid where it lands:
 * 1. declarations (custom psets, user-defined types) and document info;
 * 2. removed facets; replaced facets (re-added in phase 5);
 * 3. value and relation changes; specification field changes;
 * 4. specification order (new specs restored in place, without facets
 *    that move in from elsewhere);
 * 5. facet order per section (moves across specs/sections, restores);
 * 6. requirement field changes (after moves, so a facet that became a
 *    requirement has its optionality); 7. removed specs; removed
 *    declarations.
 */

import type { IDSFacet, IDSSpecification } from '@ifc-lite/ids';
import { REQUIRED_FIELDS } from '../document/fields.js';
import { locateFacet, locateNode } from '../document/node-index.js';
import type { FacetNodes, Section, SpecNodes, StudioDocument } from '../document/types.js';
import type { FacetPatch, PrimitiveOp, RequirementSnapshot, SpecPatch } from '../ops/types.js';
import { applyPrimitive } from '../reducer/apply.js';
import { deriveId, type Uuid } from '../uuid.js';
import { SECTIONS } from './align.js';
import { snapshot } from './compare.js';
import type { DiffEntry, DocumentDiff } from './types.js';

export interface PatchOptions {
  /** Seed for the deterministic op ids (default: `diff`). */
  seed?: string;
}

interface NewFacet {
  facet: IDSFacet;
  nodes: FacetNodes;
  requirement?: RequirementSnapshot;
}

type Entry<K extends DiffEntry['kind']> = Extract<DiffEntry, { kind: K }>;

function only<K extends DiffEntry['kind']>(entries: readonly DiffEntry[], kind: K): Entry<K>[] {
  return entries.filter((e): e is Entry<K> => e.kind === kind);
}

/** The new facets a `spec.added` entry carries, and the spec without facets that move in. */
function splitAddedSpec(e: Entry<'spec.added'>, movedIn: Set<Uuid>, store: Map<Uuid, NewFacet>): { spec: IDSSpecification; nodes: SpecNodes } {
  const app = e.spec.applicability.facets
    .map((facet, j) => ({ facet, nodes: e.nodes.applicability[j] }))
    .filter((x) => !movedIn.has(x.nodes.id));
  const req = e.spec.requirements
    .map((r, j) => ({ r, nodes: e.nodes.requirements[j] }))
    .filter((x) => !movedIn.has(x.nodes.id));
  for (const x of app) store.set(x.nodes.id, { facet: x.facet, nodes: x.nodes });
  for (const x of req) {
    const requirement = snapshot(x.r);
    store.set(x.nodes.id, { facet: x.r.facet, nodes: x.nodes, ...(requirement ? { requirement } : {}) });
  }
  return {
    spec: { ...e.spec, applicability: { ...e.spec.applicability, facets: app.map((x) => x.facet) }, requirements: req.map((x) => x.r) },
    nodes: { id: e.nodes.id, applicability: app.map((x) => x.nodes), requirements: req.map((x) => x.nodes) },
  };
}

class Builder {
  readonly ops: PrimitiveOp[] = [];
  constructor(
    public doc: StudioDocument,
    private readonly seed: string,
  ) {}

  push<K extends PrimitiveOp['kind']>(kind: K, payload: Extract<PrimitiveOp, { kind: K }>['payload']): void {
    const op = { kind, opId: deriveId(this.seed, `patch:${this.ops.length}`), payload } as PrimitiveOp;
    this.doc = applyPrimitive(this.doc, op).doc;
    this.ops.push(op);
  }
}

function section(doc: StudioDocument, specId: Uuid, s: Section): Uuid[] {
  const loc = locateNode(doc, specId);
  if (loc?.kind !== 'spec') return [];
  const nodes = doc.nodes.specs[loc.specIndex];
  return (s === 'applicability' ? nodes.applicability : nodes.requirements).map((n) => n.id);
}

function valueChanges(b: Builder, entries: readonly DiffEntry[], byNodeId: boolean): void {
  const droppedEntity = new Set(
    only(entries, 'facet.valueChanged')
      .filter((e) => e.field === 'partOf.entity.name' && !e.new)
      .map((e) => e.facetId),
  );
  for (const e of only(entries, 'facet.valueChanged')) {
    if (e.field === 'partOf.entity.predefinedType' && droppedEntity.has(e.facetId)) continue;
    const loc = locateFacet(b.doc, e.facetId);
    const nodes = loc && b.doc.nodes.specs[loc.specIndex][loc.section === 'applicability' ? 'applicability' : 'requirements'][loc.facetIndex];
    const current = nodes?.constraints[e.field];
    // Within one lineage a re-created constraint has a new node id; reset
    // the field so the constraint takes the id it has in `b`.
    if (byNodeId && e.new && current && e.constraintId && current !== e.constraintId && !REQUIRED_FIELDS.has(e.field) && e.field !== 'partOf.entity.name') {
      b.push('facet.setField', { facetId: e.facetId, field: e.field, value: null });
    }
    b.push('facet.setField', {
      facetId: e.facetId,
      field: e.field,
      value: e.new ? { kind: 'raw', constraint: e.new } : null,
      ...(e.new && e.constraintId ? { constraintId: e.constraintId } : {}),
    });
  }
  for (const e of only(entries, 'facet.relationChanged')) {
    b.push('facet.patch', { facetId: e.facetId, set: { relation: e.new.relation, rawRelation: e.new.rawRelation ?? null } });
  }
}

function specChanges(b: Builder, entries: readonly DiffEntry[]): void {
  const patches = new Map<Uuid, SpecPatch>();
  for (const e of only(entries, 'spec.changed')) {
    const set = patches.get(e.specId) ?? {};
    (set as Record<string, unknown>)[e.field] = e.new ?? null;
    patches.set(e.specId, set);
  }
  for (const [specId, set] of patches) b.push('spec.patch', { specId, set });
}

function reorder(b: Builder, diff: DocumentDiff, store: Map<Uuid, NewFacet>, added: Map<Uuid, Entry<'spec.added'>>, movedIn: Set<Uuid>): void {
  diff.order.specs.forEach((specId, i) => {
    const current = b.doc.ids.specifications.findIndex((s) => s.id === specId);
    if (current === i) return;
    if (current >= 0) {
      b.push('spec.move', { specId, toIndex: i });
      return;
    }
    const e = added.get(specId);
    if (!e) throw new Error(`diffToOps: no content for new specification ${specId}`);
    const { spec, nodes } = splitAddedSpec(e, movedIn, store);
    b.push('spec.restore', { index: i, spec, nodes });
  });
  for (const specId of diff.order.specs) {
    for (const s of SECTIONS) {
      const target = diff.order.sections[specId]?.[s] ?? [];
      target.forEach((facetId, j) => {
        if (section(b.doc, specId, s)[j] === facetId) return;
        if (locateFacet(b.doc, facetId)) {
          b.push('facet.move', { facetId, toSpecId: specId, toSection: s, toIndex: j });
          return;
        }
        const n = store.get(facetId);
        if (!n) throw new Error(`diffToOps: no content for new facet ${facetId}`);
        b.push('facet.restore', {
          specId,
          section: s,
          index: j,
          facet: n.facet,
          nodes: n.nodes,
          ...(s === 'requirements' && n.requirement ? { requirement: n.requirement } : {}),
        });
      });
    }
  }
}

/** Ops that turn `a` into the document `diff` was computed against. */
export function diffToOps(a: StudioDocument, diff: DocumentDiff, options: PatchOptions = {}): PrimitiveOp[] {
  const b = new Builder(a, options.seed ?? 'diff');
  const entries = diff.entries;
  for (const e of only(entries, 'custom.psetDeclared')) {
    if (b.doc.meta.custom.psets.some((d) => d.name === e.decl.name)) b.push('meta.custom.removePset', { name: e.decl.name });
    b.push('meta.custom.declarePset', { decl: e.decl });
  }
  for (const e of only(entries, 'custom.userDefinedTypeDeclared')) b.push('meta.custom.declareUserDefinedType', e.decl);
  for (const e of only(entries, 'info.changed')) b.push('doc.setInfo', { field: e.field, value: e.new ?? null });
  for (const e of only(entries, 'facet.removed')) b.push('facet.remove', { facetId: e.facetId });
  const store = new Map<Uuid, NewFacet>();
  for (const e of [...only(entries, 'facet.added'), ...only(entries, 'facet.replaced')]) {
    store.set(e.nodes.id, { facet: e.facet, nodes: e.nodes, ...(e.requirement ? { requirement: e.requirement } : {}) });
  }
  for (const e of only(entries, 'facet.replaced')) b.push('facet.remove', { facetId: e.facetId });
  valueChanges(b, entries, diff.byNodeId);
  specChanges(b, entries);
  const added = new Map(only(entries, 'spec.added').map((e) => [e.specId, e]));
  const movedIn = new Set(only(entries, 'facet.moved').map((e) => e.facetId));
  reorder(b, diff, store, added, movedIn);
  for (const e of only(entries, 'requirement.changed')) {
    b.push('facet.patch', { facetId: e.facetId, set: { [e.field]: e.new ?? null } as FacetPatch });
  }
  for (const e of only(entries, 'spec.removed')) b.push('spec.remove', { specId: e.specId });
  for (const e of only(entries, 'custom.psetRemoved')) {
    const redeclared = entries.some((x) => x.kind === 'custom.psetDeclared' && x.decl.name === e.decl.name);
    if (!redeclared) b.push('meta.custom.removePset', { name: e.decl.name });
  }
  for (const e of only(entries, 'custom.userDefinedTypeRemoved')) b.push('meta.custom.removeUserDefinedType', e.decl);
  return b.ops;
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Compound (`bulk.*`) ops (§3.5). Each expands, against the document state
 * at its position in the batch, into primitive ops; the reducer applies the
 * expansion, so a compound op inverts like any batch and undoes in one
 * history step. Expansion is pure: expanded op ids derive from the compound
 * op's id.
 */

import type { IDSConstraint, IDSFacet } from '@ifc-lite/ids';
import { getField, type FacetFieldName } from '../document/fields.js';
import type { StudioDocument } from '../document/types.js';
import { validateOp } from '../ops/schema.js';
import type {
  BulkApplyTemplateOp,
  BulkRenamePropertyOp,
  BulkRetargetEntityOp,
  CompoundOp,
  PrimitiveOp,
} from '../ops/types.js';
import { OpApplyError } from '../reducer/edit.js';
import { deriveId, type Uuid } from '../uuid.js';

interface FacetVisit {
  facetId: Uuid;
  facet: IDSFacet;
}

function visitFacets(doc: StudioDocument, scope: readonly Uuid[] | undefined): FacetVisit[] {
  const allowed = scope ? new Set(scope) : undefined;
  const out: FacetVisit[] = [];
  doc.ids.specifications.forEach((spec, i) => {
    if (allowed && !allowed.has(spec.id)) return;
    const nodes = doc.nodes.specs[i];
    spec.applicability.facets.forEach((facet, j) => out.push({ facetId: nodes.applicability[j].id, facet }));
    spec.requirements.forEach((r) => out.push({ facetId: r.id, facet: r.facet }));
  });
  return out;
}

function literal(c: IDSConstraint | undefined): string | undefined {
  return c?.type === 'simpleValue' ? c.value : undefined;
}

class Emitter {
  readonly ops: PrimitiveOp[] = [];
  constructor(private readonly parent: { opId: Uuid }) {}
  setField(facetId: Uuid, field: FacetFieldName, constraint: IDSConstraint): void {
    this.ops.push({
      kind: 'facet.setField',
      opId: deriveId(this.parent.opId, `x:${this.ops.length}`),
      payload: { facetId, field, value: { kind: 'raw', constraint } },
    });
  }
}

function expandRenameProperty(doc: StudioDocument, op: BulkRenamePropertyOp): PrimitiveOp[] {
  const { fromPset, fromName, toPset, toName, scope } = op.payload;
  const out = new Emitter(op);
  for (const { facetId, facet } of visitFacets(doc, scope)) {
    if (facet.type !== 'property') continue;
    if (literal(facet.propertySet) !== fromPset || literal(facet.baseName) !== fromName) continue;
    if (toPset !== fromPset) out.setField(facetId, 'property.propertySet', { type: 'simpleValue', value: toPset });
    if (toName !== fromName) out.setField(facetId, 'property.baseName', { type: 'simpleValue', value: toName });
  }
  return out.ops;
}

/** Replace `from` (case-insensitive) in a literal or enumeration entity-name constraint. */
function retarget(c: IDSConstraint | undefined, from: string, to: string): IDSConstraint | undefined {
  const fromUpper = from.toUpperCase();
  const toUpper = to.toUpperCase();
  if (c?.type === 'simpleValue' && c.value.toUpperCase() === fromUpper) return { type: 'simpleValue', value: toUpper };
  if (c?.type === 'enumeration' && c.values.some((v) => v.toUpperCase() === fromUpper)) {
    const values = [...new Set(c.values.map((v) => (v.toUpperCase() === fromUpper ? toUpper : v)))];
    return { ...c, values };
  }
  return undefined;
}

function expandRetargetEntity(doc: StudioDocument, op: BulkRetargetEntityOp): PrimitiveOp[] {
  const { from, to, scope } = op.payload;
  const out = new Emitter(op);
  for (const { facetId, facet } of visitFacets(doc, scope)) {
    const field: FacetFieldName | undefined =
      facet.type === 'entity' ? 'entity.name' : facet.type === 'partOf' ? 'partOf.entity.name' : undefined;
    if (!field) continue;
    const next = retarget(getField(facet, field), from, to);
    if (next) out.setField(facetId, field, next);
  }
  return out.ops;
}

const PLACEHOLDER = /\{\{\s*(id:)?([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

function substitute(value: unknown, fill: (isId: boolean, name: string) => string): unknown {
  if (typeof value === 'string') return value.replace(PLACEHOLDER, (_m, id: string | undefined, name: string) => fill(!!id, name));
  if (Array.isArray(value)) return value.map((v) => substitute(v, fill));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, fill)]));
  }
  return value;
}

function expandApplyTemplate(op: BulkApplyTemplateOp): PrimitiveOp[] {
  const { template, params } = op.payload;
  const declared = new Map(template.params.map((p) => [p.name, p]));
  for (const name of Object.keys(params)) {
    if (!declared.has(name)) throw new OpApplyError('GATE-OP-002', `template ${template.id} has no parameter "${name}"`);
  }
  const fill = (isId: boolean, name: string): string => {
    if (isId) return deriveId(op.opId, `tpl:${name}`);
    const value = params[name] ?? declared.get(name)?.default;
    if (value === undefined) {
      throw new OpApplyError('GATE-OP-002', `template ${template.id} needs parameter "${name}"`);
    }
    return value;
  };
  return template.ops.map((t, i) => {
    const candidate = {
      kind: t.kind,
      opId: deriveId(op.opId, `t:${i}`),
      payload: substitute(t.payload, fill),
    };
    const checked = validateOp(candidate);
    if (!checked.ok) {
      const first = checked.errors[0];
      throw new OpApplyError('GATE-OP-001', `template ${template.id} op ${i} (${t.kind}): ${first.path}: ${first.message}`);
    }
    if (checked.op.kind.startsWith('bulk.')) {
      throw new OpApplyError('GATE-OP-001', `template ${template.id} op ${i}: templates cannot nest compound ops`);
    }
    return checked.op as PrimitiveOp;
  });
}

/** Expand a compound op into primitives against `doc`. */
export function expandCompound(doc: StudioDocument, op: CompoundOp): PrimitiveOp[] {
  switch (op.kind) {
    case 'bulk.renameProperty':
      return expandRenameProperty(doc, op);
    case 'bulk.retargetEntity':
      return expandRetargetEntity(doc, op);
    case 'bulk.applyTemplate':
      return expandApplyTemplate(op);
  }
}

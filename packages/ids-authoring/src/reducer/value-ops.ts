/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Reducers for field/value ops and `meta.custom.*`. Each returns its exact inverse. */

import type { IDSConstraint } from '@ifc-lite/ids';
import { FACET_FIELDS, fieldBelongsTo, getField, setField, type FacetFieldName } from '../document/fields.js';
import { locateNode } from '../document/node-index.js';
import type { StudioDocument } from '../document/types.js';
import { normaliseValue } from '../ops/draft.js';
import type {
  ConstraintIds,
  MetaDeclarePsetOp,
  MetaRemovePsetOp,
  PrimitiveOp,
  Scalar,
  ValueAddEnumOp,
  ValueInput,
  ValueRemoveEnumOp,
} from '../ops/types.js';
import { deriveId, type Uuid } from '../uuid.js';
import { insertAt, itemAt, OpApplyError, removeAt, replaceAt, replaceItem, requireFacet } from './edit.js';
import { inv, type StepResult } from './spec-ops.js';

/**
 * Set (or remove, with `undefined`) one constraint field. The inverse
 * restores every field whose constraint or id changed — removing
 * `partOf.entity.name` also drops `partOf.entity.predefinedType`, and both
 * come back on undo, with their original ids.
 */
export function applyConstraint(
  doc: StudioDocument,
  forward: { opId: Uuid },
  facetId: Uuid,
  field: FacetFieldName,
  value: IDSConstraint | undefined,
  constraintId: Uuid | undefined,
): StepResult {
  const loc = requireFacet(doc, facetId);
  const item = itemAt(doc, loc);
  if (!fieldBelongsTo(item.facet, field)) {
    throw new OpApplyError('GATE-STR-002', `field ${field} does not belong to a ${item.facet.type} facet`);
  }
  let facet;
  try {
    facet = setField(item.facet, field, value);
  } catch (err) {
    throw new OpApplyError('GATE-STR-002', err instanceof Error ? err.message : String(err));
  }
  const constraints: ConstraintIds = {};
  for (const f of FACET_FIELDS[facet.type] as readonly FacetFieldName[]) {
    if (getField(facet, f) === undefined) continue;
    const previous = item.nodes.constraints[f];
    if (previous) constraints[f] = previous;
    else {
      const id = (f === field ? constraintId : undefined) ?? deriveId(forward.opId, f);
      if (locateNode(doc, id)) throw new OpApplyError('GATE-STR-001', `node id ${id} already exists`);
      constraints[f] = id;
    }
  }
  const inverse: PrimitiveOp[] = [];
  const touched: Uuid[] = [loc.specId, facetId];
  for (const f of FACET_FIELDS[item.facet.type] as readonly FacetFieldName[]) {
    const before = getField(item.facet, f);
    const after = getField(facet, f);
    if (before === after && item.nodes.constraints[f] === constraints[f]) continue;
    const oldId = item.nodes.constraints[f];
    inverse.push(
      inv(forward, inverse.length, 'facet.setField', {
        facetId,
        field: f,
        value: before ? { kind: 'raw', constraint: before } : null,
        ...(oldId ? { constraintId: oldId } : {}),
      }),
    );
    const id = constraints[f] ?? oldId;
    if (id) touched.push(id);
  }
  return {
    doc: replaceItem(doc, loc, { ...item, facet, nodes: { id: facetId, constraints } }),
    inverse,
    touched,
  };
}

export function applySetField(
  doc: StudioDocument,
  forward: { opId: Uuid },
  facetId: Uuid,
  field: FacetFieldName,
  value: ValueInput | null,
  constraintId: Uuid | undefined,
): StepResult {
  const constraint = value === null ? undefined : normaliseValue(value, field);
  return applyConstraint(doc, forward, facetId, field, constraint, constraintId);
}

function scalarString(v: Scalar): string {
  return String(v);
}

export function applyAddEnumValue(doc: StudioDocument, op: ValueAddEnumOp): StepResult {
  const { facetId, field, value, constraintId } = op.payload;
  const loc = requireFacet(doc, facetId);
  const current = getField(itemAt(doc, loc).facet, field);
  const v = scalarString(value);
  let next: IDSConstraint;
  if (!current) next = { type: 'simpleValue', value: v };
  else if (current.type === 'simpleValue') {
    next = current.value === v ? current : { type: 'enumeration', values: [current.value, v] };
  } else if (current.type === 'enumeration') {
    next = current.values.includes(v) ? current : { ...current, values: [...current.values, v] };
  } else {
    throw new OpApplyError('GATE-VAL-008', `cannot add an enumeration value to a ${current.type} constraint`);
  }
  return applyConstraint(doc, op, facetId, field, next, constraintId);
}

export function applyRemoveEnumValue(doc: StudioDocument, op: ValueRemoveEnumOp): StepResult {
  const { facetId, field, value } = op.payload;
  const loc = requireFacet(doc, facetId);
  const current = getField(itemAt(doc, loc).facet, field);
  const v = scalarString(value);
  if (!current || current.type !== 'enumeration' || !current.values.includes(v)) {
    throw new OpApplyError('GATE-VAL-008', `${field} has no enumeration value "${v}"`);
  }
  if (current.values.length === 1) {
    throw new OpApplyError('GATE-VAL-008', `cannot remove the last enumeration value of ${field}`);
  }
  const next: IDSConstraint = { ...current, values: current.values.filter((x) => x !== v) };
  return applyConstraint(doc, op, facetId, field, next, undefined);
}

export function applyDeclarePset(doc: StudioDocument, op: MetaDeclarePsetOp): StepResult {
  const { decl, index } = op.payload;
  const psets = doc.meta.custom.psets;
  const existing = psets.findIndex((p) => p.name === decl.name);
  let next;
  let inverse: PrimitiveOp;
  if (existing >= 0) {
    next = replaceAt(psets, existing, decl);
    inverse = inv(op, 0, 'meta.custom.declarePset', { decl: psets[existing] });
  } else {
    const at = index ?? psets.length;
    if (!Number.isInteger(at) || at < 0 || at > psets.length) {
      throw new OpApplyError('GATE-STR-006', `pset index ${at} is out of range 0..${psets.length}`);
    }
    next = insertAt(psets, at, decl);
    inverse = inv(op, 0, 'meta.custom.removePset', { name: decl.name });
  }
  return {
    doc: { ...doc, meta: { ...doc.meta, custom: { ...doc.meta.custom, psets: next } } },
    inverse: [inverse],
    touched: [doc.nodes.document],
  };
}

export function applyRemovePset(doc: StudioDocument, op: MetaRemovePsetOp): StepResult {
  const psets = doc.meta.custom.psets;
  const index = psets.findIndex((p) => p.name === op.payload.name);
  if (index < 0) throw new OpApplyError('GATE-CUST-004', `no custom property set "${op.payload.name}" is declared`);
  return {
    doc: { ...doc, meta: { ...doc.meta, custom: { ...doc.meta.custom, psets: removeAt(psets, index) } } },
    inverse: [inv(op, 0, 'meta.custom.declarePset', { decl: psets[index], index })],
    touched: [doc.nodes.document],
  };
}

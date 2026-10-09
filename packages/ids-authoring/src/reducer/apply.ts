/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The reducer (§4): `apply(doc, ops) → { doc, inverses, touched, expanded }`.
 *
 * Pure and synchronous, with structural sharing. Compound ops are expanded
 * against the document state at their position (`expandCompound`) and the
 * expansion is applied as primitives, so every applied op has an exact
 * inverse captured at apply time. `inverses` is already in undo order:
 * applying it to the result yields a document deep-equal to the input.
 *
 * The reducer trusts its input to have passed the gate; an op the gate
 * would refuse throws `OpApplyError` (with the gate's code) and nothing
 * is applied.
 */

import type { StudioDocument } from '../document/types.js';
import { expandCompound } from '../compound/expand.js';
import type { PrimitiveOp, StudioOp } from '../ops/types.js';
import type { Uuid } from '../uuid.js';
import {
  applyCommentAdd,
  applyCommentRemoveReply,
  applyCommentRemoveThread,
  applyCommentReply,
  applyCommentResolve,
  applyCommentRestoreThread,
} from './comment-ops.js';
import { OpApplyError } from './edit.js';
import { applyTestAdd, applyTestRemove, applyTestRestore, applyTestSetExpectation } from './test-ops.js';
import {
  applyFacetAdd,
  applyFacetMove,
  applyFacetPatch,
  applyFacetRemove,
  applyFacetReplace,
  applyFacetRestore,
} from './facet-ops.js';
import {
  applyDocSetInfo,
  applySpecAdd,
  applySpecDuplicate,
  applySpecMove,
  applySpecPatch,
  applySpecRemove,
  applySpecRestore,
  cardinalityPatch,
  type StepResult,
} from './spec-ops.js';
import {
  applyAddEnumValue,
  applyDeclarePset,
  applyDeclareUserDefinedType,
  applyRemoveEnumValue,
  applyRemovePset,
  applyRemoveUserDefinedType,
  applySetField,
} from './value-ops.js';

export interface ApplyResult {
  doc: StudioDocument;
  /** Undo ops, in the order to apply them. */
  inverses: PrimitiveOp[];
  /** Node ids created, changed, moved or removed. */
  touched: Set<Uuid>;
  /** The primitive ops actually applied (compound ops expanded). */
  expanded: PrimitiveOp[];
}

/** Apply one primitive op. */
export function applyPrimitive(doc: StudioDocument, op: PrimitiveOp): StepResult {
  switch (op.kind) {
    case 'doc.setInfo':
      return applyDocSetInfo(doc, op);
    case 'spec.add':
      return applySpecAdd(doc, op);
    case 'spec.remove':
      return applySpecRemove(doc, op);
    case 'spec.duplicate':
      return applySpecDuplicate(doc, op);
    case 'spec.move':
      return applySpecMove(doc, op);
    case 'spec.set':
      return applySpecPatch(doc, op, op.payload.specId, { [op.payload.field]: op.payload.value });
    case 'spec.setCardinality':
      return applySpecPatch(doc, op, op.payload.specId, cardinalityPatch(op.payload.cardinality));
    case 'spec.setIfcVersions':
      return applySpecPatch(doc, op, op.payload.specId, { ifcVersions: op.payload.versions, ifcVersionRaw: null });
    case 'spec.restore':
      return applySpecRestore(doc, op);
    case 'spec.patch':
      return applySpecPatch(doc, op, op.payload.specId, op.payload.set);
    case 'facet.add':
      return applyFacetAdd(doc, op);
    case 'facet.remove':
      return applyFacetRemove(doc, op);
    case 'facet.move':
      return applyFacetMove(doc, op);
    case 'facet.replace':
      return applyFacetReplace(doc, op);
    case 'facet.setField':
      return applySetField(doc, op, op.payload.facetId, op.payload.field, op.payload.value, op.payload.constraintId);
    case 'value.set':
      return applySetField(doc, op, op.payload.facetId, op.payload.field, op.payload.value, op.payload.constraintId);
    case 'facet.setRelation':
      return applyFacetPatch(doc, op, op.payload.facetId, { relation: op.payload.relation, rawRelation: null });
    case 'facet.restore':
      return applyFacetRestore(doc, op);
    case 'facet.patch':
      return applyFacetPatch(doc, op, op.payload.facetId, op.payload.set);
    case 'requirement.setOptionality':
      return applyFacetPatch(doc, op, op.payload.facetId, { optionality: op.payload.optionality, cardinalityRaw: null });
    case 'requirement.set':
      return applyFacetPatch(doc, op, op.payload.facetId, { [op.payload.field]: op.payload.value });
    case 'value.addEnumValue':
      return applyAddEnumValue(doc, op);
    case 'value.removeEnumValue':
      return applyRemoveEnumValue(doc, op);
    case 'meta.custom.declarePset':
      return applyDeclarePset(doc, op);
    case 'meta.custom.removePset':
      return applyRemovePset(doc, op);
    case 'meta.custom.declareUserDefinedType':
      return applyDeclareUserDefinedType(doc, op);
    case 'meta.custom.removeUserDefinedType':
      return applyRemoveUserDefinedType(doc, op);
    case 'meta.comment.add':
      return applyCommentAdd(doc, op);
    case 'meta.comment.reply':
      return applyCommentReply(doc, op);
    case 'meta.comment.removeReply':
      return applyCommentRemoveReply(doc, op);
    case 'meta.comment.resolve':
      return applyCommentResolve(doc, op);
    case 'meta.comment.removeThread':
      return applyCommentRemoveThread(doc, op);
    case 'meta.comment.restoreThread':
      return applyCommentRestoreThread(doc, op);
    case 'meta.test.add':
      return applyTestAdd(doc, op);
    case 'meta.test.remove':
      return applyTestRemove(doc, op);
    case 'meta.test.restore':
      return applyTestRestore(doc, op);
    case 'meta.test.setExpectation':
      return applyTestSetExpectation(doc, op);
  }
}

function isPrimitive(op: StudioOp): op is PrimitiveOp {
  return !op.kind.startsWith('bulk.');
}

/** Apply `ops` in order. Throws `OpApplyError` without partial effects. */
export function apply(doc: StudioDocument, ops: readonly StudioOp[]): ApplyResult {
  let current = doc;
  const undoSteps: PrimitiveOp[][] = [];
  const touched = new Set<Uuid>();
  const expanded: PrimitiveOp[] = [];
  for (const op of ops) {
    const primitives = isPrimitive(op) ? [op] : expandCompound(current, op);
    for (const p of primitives) {
      const step = applyPrimitive(current, p);
      current = step.doc;
      undoSteps.push(step.inverse);
      for (const id of step.touched) touched.add(id);
      expanded.push(p);
    }
  }
  const inverses: PrimitiveOp[] = [];
  for (let i = undoSteps.length - 1; i >= 0; i--) inverses.push(...undoSteps[i]);
  return { doc: current, inverses, touched, expanded };
}

export { OpApplyError };

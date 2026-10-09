/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Reducers for `facet.*` and `requirement.*` ops. Each returns its exact inverse. */

import type { IDSFacet, IDSRequirement } from '@ifc-lite/ids';
import { presentFields } from '../document/fields.js';
import { locateNode, type FacetLocation } from '../document/node-index.js';
import type { FacetNodes, StudioDocument } from '../document/types.js';
import { facetFromDraft } from '../ops/draft.js';
import type {
  ConstraintIds,
  FacetAddOp,
  FacetMoveOp,
  FacetPatch,
  FacetReplaceOp,
  FacetRestoreOp,
  PrimitiveOp,
  RequirementSnapshot,
} from '../ops/types.js';
import { deriveId, type Uuid } from '../uuid.js';
import {
  insertItem,
  itemAt,
  moveItemWithin,
  OpApplyError,
  removeItem,
  replaceItem,
  requireFacet,
  requireIndex,
  requireSpec,
  sectionLength,
  withKey,
  type SectionItem,
} from './edit.js';
import { inv, type StepResult } from './spec-ops.js';

/** Constraint ids for `facet`: keep `previous` ids, else take `given`, else derive. */
export function constraintIdsFor(
  facet: IDSFacet,
  opId: Uuid,
  given: ConstraintIds | undefined,
  previous: ConstraintIds = {},
): ConstraintIds {
  const out: ConstraintIds = {};
  for (const field of presentFields(facet)) {
    out[field] = previous[field] ?? given?.[field] ?? deriveId(opId, field);
  }
  return out;
}

function ensureFresh(doc: StudioDocument, ids: (Uuid | undefined)[]): void {
  for (const id of ids) {
    if (id && locateNode(doc, id)) throw new OpApplyError('GATE-STR-001', `node id ${id} already exists`);
  }
}

function snapshotOf(item: SectionItem): RequirementSnapshot | undefined {
  const r = item.requirement;
  if (!r) return undefined;
  let snap: RequirementSnapshot = { optionality: r.optionality };
  snap = withKey(snap, 'cardinalityRaw', r.cardinalityRaw);
  snap = withKey(snap, 'description', r.description);
  return withKey(snap, 'instructions', r.instructions);
}

/** Inverse ops that put `item` back at `loc` after it was removed. */
function restoreOp(forward: { opId: Uuid }, n: number, loc: FacetLocation, item: SectionItem): PrimitiveOp {
  const requirement = snapshotOf(item);
  return inv(forward, n, 'facet.restore', {
    specId: loc.specId,
    section: loc.section,
    index: loc.facetIndex,
    facet: item.facet,
    nodes: item.nodes,
    ...(requirement ? { requirement } : {}),
  });
}

export function applyFacetAdd(doc: StudioDocument, op: FacetAddOp): StepResult {
  const p = op.payload;
  const specIndex = requireSpec(doc, p.specId);
  const facet = facetFromDraft(p.facet);
  const constraints = constraintIdsFor(facet, op.opId, p.constraintIds);
  ensureFresh(doc, [p.facetId, ...Object.values(constraints)]);
  const len = sectionLength(doc, specIndex, p.section);
  const index = p.index ?? len;
  requireIndex(index, len, 'facet index');
  let requirement: IDSRequirement | undefined;
  if (p.section === 'requirements') {
    requirement = { id: p.facetId, facet, optionality: p.optionality ?? 'required' };
    requirement = withKey(requirement, 'description', p.description);
    requirement = withKey(requirement, 'instructions', p.instructions);
  } else if (p.optionality !== undefined || p.description !== undefined || p.instructions !== undefined) {
    throw new OpApplyError('GATE-STR-003', 'applicability facets carry no optionality, description or instructions');
  }
  return {
    doc: insertItem(doc, specIndex, p.section, index, { facet, nodes: { id: p.facetId, constraints }, requirement }),
    inverse: [inv(op, 0, 'facet.remove', { facetId: p.facetId })],
    touched: [p.specId, p.facetId],
  };
}

export function applyFacetRemove(doc: StudioDocument, op: PrimitiveOp & { kind: 'facet.remove' }): StepResult {
  const loc = requireFacet(doc, op.payload.facetId);
  const item = itemAt(doc, loc);
  return {
    doc: removeItem(doc, loc),
    inverse: [restoreOp(op, 0, loc, item)],
    touched: [loc.specId, op.payload.facetId],
  };
}

export function applyFacetRestore(doc: StudioDocument, op: FacetRestoreOp): StepResult {
  const p = op.payload;
  const specIndex = requireSpec(doc, p.specId);
  ensureFresh(doc, [p.nodes.id, ...Object.values(p.nodes.constraints)]);
  requireIndex(p.index, sectionLength(doc, specIndex, p.section), 'facet index');
  let requirement: IDSRequirement | undefined;
  if (p.section === 'requirements') {
    requirement = { ...(p.requirement ?? { optionality: 'required' }), id: p.nodes.id, facet: p.facet };
  } else if (p.requirement) {
    throw new OpApplyError('GATE-STR-003', 'applicability facets carry no requirement fields');
  }
  return {
    doc: insertItem(doc, specIndex, p.section, p.index, { facet: p.facet, nodes: p.nodes, requirement }),
    inverse: [inv(op, 0, 'facet.remove', { facetId: p.nodes.id })],
    touched: [p.specId, p.nodes.id],
  };
}

export function applyFacetMove(doc: StudioDocument, op: FacetMoveOp): StepResult {
  const p = op.payload;
  const loc = requireFacet(doc, p.facetId);
  const toSpecId = p.toSpecId ?? loc.specId;
  const toSection = p.toSection ?? loc.section;
  if (toSpecId === loc.specId && toSection === loc.section) {
    requireIndex(p.toIndex, sectionLength(doc, loc.specIndex, loc.section) - 1, 'facet index');
    return {
      doc: moveItemWithin(doc, loc, p.toIndex),
      inverse: [inv(op, 0, 'facet.move', { facetId: p.facetId, toIndex: loc.facetIndex })],
      touched: [loc.specId, p.facetId],
    };
  }
  const toSpecIndex = requireSpec(doc, toSpecId);
  const item = itemAt(doc, loc);
  const removed = removeItem(doc, loc);
  requireIndex(p.toIndex, sectionLength(removed, toSpecIndex, toSection), 'facet index');
  const moved: SectionItem =
    toSection === 'applicability'
      ? { facet: item.facet, nodes: item.nodes }
      : { ...item, requirement: item.requirement ?? { id: item.nodes.id, facet: item.facet, optionality: 'required' } };
  return {
    doc: insertItem(removed, toSpecIndex, toSection, p.toIndex, moved),
    inverse: [inv(op, 0, 'facet.remove', { facetId: p.facetId }), restoreOp(op, 1, loc, item)],
    touched: [loc.specId, toSpecId, p.facetId],
  };
}

export function applyFacetReplace(doc: StudioDocument, op: FacetReplaceOp): StepResult {
  const p = op.payload;
  const loc = requireFacet(doc, p.facetId);
  const item = itemAt(doc, loc);
  const facet = facetFromDraft(p.facet);
  const constraints = constraintIdsFor(facet, op.opId, p.constraintIds, item.nodes.constraints);
  const reused = new Set(Object.values(item.nodes.constraints));
  ensureFresh(doc, Object.values(constraints).filter((id) => !reused.has(id)));
  const nodes: FacetNodes = { id: p.facetId, constraints };
  return {
    doc: replaceItem(doc, loc, { ...item, facet, nodes }),
    inverse: [inv(op, 0, 'facet.remove', { facetId: p.facetId }), restoreOp(op, 1, loc, item)],
    touched: [loc.specId, p.facetId, ...Object.values(constraints).filter((id): id is Uuid => !!id)],
  };
}

const REQUIREMENT_KEYS = ['optionality', 'cardinalityRaw', 'description', 'instructions'] as const;

/** Apply a `FacetPatch` and return the patch that restores the old values. */
export function applyFacetPatch(doc: StudioDocument, forward: { opId: Uuid }, facetId: Uuid, patch: FacetPatch): StepResult {
  const loc = requireFacet(doc, facetId);
  const item = itemAt(doc, loc);
  const undo: FacetPatch = {};
  let facet = item.facet;
  let requirement = item.requirement;
  for (const key of REQUIREMENT_KEYS) {
    if (patch[key] === undefined) continue;
    if (!requirement) throw new OpApplyError('GATE-STR-003', `${key} only exists on requirements`);
    if (key === 'optionality') {
      undo.optionality = requirement.optionality;
      requirement = { ...requirement, optionality: patch.optionality ?? requirement.optionality };
    } else {
      undo[key] = requirement[key] ?? null;
      requirement = withKey(requirement, key, patch[key]);
    }
  }
  if (patch.relation !== undefined || patch.rawRelation !== undefined) {
    if (facet.type !== 'partOf') throw new OpApplyError('GATE-STR-002', 'relation only exists on partOf facets');
    if (patch.relation !== undefined) {
      undo.relation = facet.relation;
      facet = { ...facet, relation: patch.relation };
    }
    if (patch.rawRelation !== undefined) {
      undo.rawRelation = item.facet.type === 'partOf' ? (item.facet.rawRelation ?? null) : null;
      facet = withKey(facet, 'rawRelation', patch.rawRelation);
    }
  }
  if (patch.uri !== undefined) {
    if (facet.type !== 'property' && facet.type !== 'classification' && facet.type !== 'material') {
      throw new OpApplyError('GATE-STR-002', 'uri only exists on property, classification and material facets');
    }
    undo.uri = facet.uri ?? null;
    facet = withKey(facet, 'uri', patch.uri);
  }
  return {
    doc: replaceItem(doc, loc, { ...item, facet, requirement }),
    inverse: [inv(forward, 0, 'facet.patch', { facetId, set: undo })],
    touched: [loc.specId, facetId],
  };
}

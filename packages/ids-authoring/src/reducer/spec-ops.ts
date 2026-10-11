/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Reducers for `doc.*` and `spec.*` ops. Each returns its exact inverse. */

import type { IDSSpecification } from '@ifc-lite/ids';
import { locateNode } from '../document/node-index.js';
import type { FacetNodes, StudioDocument } from '../document/types.js';
import type { FacetFieldName } from '../document/fields.js';
import type {
  ConstraintIds,
  DocSetInfoOp,
  PrimitiveOp,
  SpecAddOp,
  SpecCardinality,
  SpecDuplicateOp,
  SpecMoveOp,
  SpecPatch,
  SpecRestoreOp,
} from '../ops/types.js';
import { deriveId, type Uuid } from '../uuid.js';
import {
  insertAt,
  insertSpec,
  OpApplyError,
  removeAt,
  removeSpec,
  requireIndex,
  requireSpec,
  setSpec,
  withKey,
} from './edit.js';

/** What one primitive op did: the new doc, its inverse ops and touched node ids. */
export interface StepResult {
  doc: StudioDocument;
  inverse: PrimitiveOp[];
  touched: Uuid[];
}

/** Build an inverse op with a deterministic id derived from the forward op. */
export function inv<K extends PrimitiveOp['kind']>(
  forward: { opId: Uuid },
  n: number,
  kind: K,
  payload: Extract<PrimitiveOp, { kind: K }>['payload'],
): PrimitiveOp {
  return { kind, opId: deriveId(forward.opId, `inverse:${n}`), payload } as PrimitiveOp;
}

export function applyDocSetInfo(doc: StudioDocument, op: DocSetInfoOp): StepResult {
  const { field, value } = op.payload;
  if (field === 'title' && value === null) throw new OpApplyError('GATE-STR-002', 'info.title is required');
  const old = doc.ids.info[field];
  const info = withKey(doc.ids.info, field, value);
  return {
    doc: { ...doc, ids: { ...doc.ids, info } },
    inverse: [inv(op, 0, 'doc.setInfo', { field, value: old ?? null })],
    touched: [doc.nodes.document],
  };
}

export function cardinalityPatch(cardinality: SpecCardinality): SpecPatch {
  switch (cardinality) {
    case 'required':
      return { minOccurs: 1, maxOccurs: null };
    case 'optional':
      return { minOccurs: 0, maxOccurs: null };
    case 'prohibited':
      return { minOccurs: 0, maxOccurs: 0 };
  }
}

function ensureFreshId(doc: StudioDocument, id: Uuid): void {
  if (locateNode(doc, id)) throw new OpApplyError('GATE-STR-001', `node id ${id} already exists`);
}

export function applySpecAdd(doc: StudioDocument, op: SpecAddOp): StepResult {
  const p = op.payload;
  ensureFreshId(doc, p.specId);
  const count = doc.ids.specifications.length;
  const index = p.index ?? count;
  requireIndex(index, count, 'spec index');
  let spec: IDSSpecification = {
    id: p.specId,
    name: p.name,
    ifcVersions: [...p.ifcVersions],
    applicability: { facets: [] },
    requirements: [],
  };
  if (p.description !== undefined) spec.description = p.description;
  if (p.instructions !== undefined) spec.instructions = p.instructions;
  if (p.identifier !== undefined) spec.identifier = p.identifier;
  spec = patchSpec(spec, cardinalityPatch(p.cardinality ?? 'required'));
  return {
    doc: insertSpec(doc, index, spec, { id: p.specId, applicability: [], requirements: [] }),
    inverse: [inv(op, 0, 'spec.remove', { specId: p.specId })],
    touched: [p.specId],
  };
}

export function applySpecRemove(doc: StudioDocument, op: PrimitiveOp & { kind: 'spec.remove' }): StepResult {
  const index = requireSpec(doc, op.payload.specId);
  const spec = doc.ids.specifications[index];
  const nodes = doc.nodes.specs[index];
  return {
    doc: removeSpec(doc, index),
    inverse: [inv(op, 0, 'spec.restore', { index, spec, nodes })],
    touched: [op.payload.specId],
  };
}

export function applySpecRestore(doc: StudioDocument, op: SpecRestoreOp): StepResult {
  const { index, spec, nodes } = op.payload;
  if (spec.id !== nodes.id) throw new OpApplyError('GATE-STR-001', 'spec.id must equal nodes.id');
  ensureFreshId(doc, nodes.id);
  requireIndex(index, doc.ids.specifications.length, 'spec index');
  return {
    doc: insertSpec(doc, index, spec, nodes),
    inverse: [inv(op, 0, 'spec.remove', { specId: spec.id })],
    touched: [spec.id],
  };
}

function copyFacetNodes(nodes: FacetNodes, seed: string, salt: string): FacetNodes {
  const constraints: ConstraintIds = {};
  for (const field of Object.keys(nodes.constraints) as FacetFieldName[]) {
    if (nodes.constraints[field]) constraints[field] = deriveId(seed, `${salt}:${field}`);
  }
  return { id: deriveId(seed, salt), constraints };
}

export function applySpecDuplicate(doc: StudioDocument, op: SpecDuplicateOp): StepResult {
  const { specId, newSpecId, nameSuffix } = op.payload;
  const index = requireSpec(doc, specId);
  ensureFreshId(doc, newSpecId);
  const source = doc.ids.specifications[index];
  const sourceNodes = doc.nodes.specs[index];
  const applicability = sourceNodes.applicability.map((n, j) => copyFacetNodes(n, op.opId, `app:${j}`));
  const requirements = sourceNodes.requirements.map((n, j) => copyFacetNodes(n, op.opId, `req:${j}`));
  // A duplicate is a new specification: it takes a fresh name and drops the
  // user-controlled `identifier`, which must stay unique per document.
  const spec: IDSSpecification = withKey(
    {
      ...source,
      id: newSpecId,
      name: `${source.name}${nameSuffix ?? ' (copy)'}`,
      requirements: source.requirements.map((r, j) => ({ ...r, id: requirements[j].id })),
    },
    'identifier',
    undefined,
  );
  return {
    doc: insertSpec(doc, index + 1, spec, { id: newSpecId, applicability, requirements }),
    inverse: [inv(op, 0, 'spec.remove', { specId: newSpecId })],
    touched: [newSpecId],
  };
}

export function applySpecMove(doc: StudioDocument, op: SpecMoveOp): StepResult {
  const { specId, toIndex } = op.payload;
  const from = requireSpec(doc, specId);
  requireIndex(toIndex, doc.ids.specifications.length - 1, 'spec index');
  const specs = removeAt(doc.ids.specifications, from);
  const nodes = removeAt(doc.nodes.specs, from);
  return {
    doc: {
      ...doc,
      ids: { ...doc.ids, specifications: insertAt(specs, toIndex, doc.ids.specifications[from]) },
      nodes: { ...doc.nodes, specs: insertAt(nodes, toIndex, doc.nodes.specs[from]) },
    },
    inverse: [inv(op, 0, 'spec.move', { specId, toIndex: from })],
    touched: [specId],
  };
}

const PATCH_KEYS = [
  'name',
  'description',
  'instructions',
  'identifier',
  'ifcVersions',
  'ifcVersionRaw',
  'minOccurs',
  'maxOccurs',
  'applicabilityCardinality',
] as const;

function readPatchKey(spec: IDSSpecification, key: (typeof PATCH_KEYS)[number]): unknown {
  return key === 'applicabilityCardinality' ? spec.applicability.cardinality : spec[key];
}

function patchSpec(spec: IDSSpecification, patch: SpecPatch): IDSSpecification {
  let next = spec;
  for (const key of PATCH_KEYS) {
    if (!(key in patch) || patch[key] === undefined) continue;
    if (key === 'applicabilityCardinality') {
      next = { ...next, applicability: withKey(next.applicability, 'cardinality', patch.applicabilityCardinality) };
    } else if (key === 'name' || key === 'ifcVersions') {
      const value = patch[key];
      if (value === null) throw new OpApplyError('GATE-STR-002', `spec.${key} is required`);
      next = key === 'name' ? { ...next, name: value as string } : { ...next, ifcVersions: [...(value as string[])] as IDSSpecification['ifcVersions'] };
    } else {
      next = withKey(next, key, patch[key] as IDSSpecification[typeof key] | null);
    }
  }
  return next;
}

/** Apply a `SpecPatch` and return the patch that restores the old values. */
export function applySpecPatch(
  doc: StudioDocument,
  forward: { opId: Uuid },
  specId: Uuid,
  patch: SpecPatch,
): StepResult {
  const index = requireSpec(doc, specId);
  const spec = doc.ids.specifications[index];
  const undo: Record<string, unknown> = {};
  for (const key of PATCH_KEYS) {
    if (!(key in patch) || patch[key] === undefined) continue;
    undo[key] = readPatchKey(spec, key) ?? null;
  }
  return {
    doc: setSpec(doc, index, patchSpec(spec, patch), doc.nodes.specs[index]),
    inverse: [inv(forward, 0, 'spec.patch', { specId, set: undo as SpecPatch })],
    touched: [specId],
  };
}

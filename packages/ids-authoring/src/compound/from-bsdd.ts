/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Expansion of `bulk.fromBsddClass` (05-bsdd.md §2.1–2.3): bSDD classes →
 * an optional new specification, an entity facet, a classification facet.
 * Pure: the op carries class snapshots, ids derive from the op id.
 */

import { locateSpec } from '../document/node-index.js';
import type { StudioDocument } from '../document/types.js';
import type { BsddClassSnapshot, BulkFromBsddClassOp, ConstraintDraft, FacetDraft, PrimitiveOp } from '../ops/types.js';
import { OpApplyError } from '../reducer/edit.js';
import { deriveId, type Uuid } from '../uuid.js';

/** `equals` for one value, `oneOf` for several. */
export function oneOrMany(values: readonly string[]): ConstraintDraft {
  return values.length === 1 ? { kind: 'equals', value: values[0] } : { kind: 'oneOf', values: [...values] };
}

function distinct(values: readonly string[]): string[] {
  const seen = new Set<string>();
  return values.filter((v) => {
    const key = v.toUpperCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The entity facet for the classes: their related entities, or the chosen subset. */
function entityDraft(classes: readonly BsddClassSnapshot[], chosen: readonly string[] | undefined): FacetDraft {
  const refs = classes.flatMap((c) => c.relatedIfcEntities ?? []);
  const names = distinct(chosen ?? refs.map((r) => r.entity));
  if (names.length === 0) {
    throw new OpApplyError('GATE-OP-002', `bSDD class ${classes.map((c) => c.code).join(', ')} relates to no IFC entity; choose the entity`);
  }
  const draft: FacetDraft = { type: 'entity', name: oneOrMany(names) };
  if (names.length !== 1) return draft;
  // A predefined type only when every class names the same one for this entity.
  const forEntity = classes.map((c) => (c.relatedIfcEntities ?? []).filter((r) => r.entity.toUpperCase() === names[0].toUpperCase()));
  const pdts = distinct(forEntity.flatMap((list) => list.map((r) => r.predefinedType ?? '')));
  const everyClassHasOne = forEntity.every((list) => list.length === 1 && list[0].predefinedType);
  if (pdts.length === 1 && pdts[0] !== '' && everyClassHasOne) draft.predefinedType = { kind: 'equals', value: pdts[0] };
  return draft;
}

function classificationDraft(classes: readonly BsddClassSnapshot[], withUri: boolean): FacetDraft {
  const draft: Extract<FacetDraft, { type: 'classification' }> = {
    type: 'classification',
    system: { kind: 'equals', value: classes[0].dictionaryName },
    value: oneOrMany(distinct(classes.map((c) => c.code))),
  };
  if (withUri && classes.length === 1) draft.uri = classes[0].uri;
  return draft;
}

/** Ids of the facets `bulk.fromBsddClass` creates, derived from its op id. */
export function bsddFacetId(opId: Uuid, role: string): Uuid {
  return deriveId(opId, `bsdd:${role}`);
}

class Out {
  readonly ops: PrimitiveOp[] = [];
  constructor(readonly opId: Uuid) {}
  nextId(): Uuid {
    return deriveId(this.opId, `x:${this.ops.length}`);
  }
  addFacet(specId: Uuid, role: string, section: 'applicability' | 'requirements', facet: FacetDraft, extra: { optionality?: 'required' | 'optional' | 'prohibited' } = {}): void {
    this.ops.push({ kind: 'facet.add', opId: this.nextId(), payload: { specId, section, facetId: bsddFacetId(this.opId, role), facet, ...extra } });
  }
}

/** Resolve the target specification id, emitting `spec.add` for a new one. */
function target(doc: StudioDocument, op: BulkFromBsddClassOp, out: Out): Uuid {
  const t = op.payload.target;
  if ('specId' in t) {
    if (locateSpec(doc, t.specId) === undefined) throw new OpApplyError('GATE-STR-001', `unknown specification ${t.specId}`);
    return t.specId;
  }
  const s = t.newSpec;
  out.ops.push({
    kind: 'spec.add',
    opId: out.nextId(),
    payload: {
      specId: s.specId,
      name: s.name,
      ifcVersions: s.ifcVersions,
      ...(s.index !== undefined ? { index: s.index } : {}),
      ...(s.description ? { description: s.description } : {}),
      ...(s.identifier ? { identifier: s.identifier } : {}),
      ...(s.cardinality ? { cardinality: s.cardinality } : {}),
    },
  });
  return s.specId;
}

export function expandFromBsddClass(doc: StudioDocument, op: BulkFromBsddClassOp): PrimitiveOp[] {
  const { classes, classification, entity } = op.payload;
  const dictionaries = new Set(classes.map((c) => c.dictionaryUri));
  if (dictionaries.size > 1) throw new OpApplyError('GATE-OP-002', 'bulk.fromBsddClass takes classes of one dictionary at a time');
  const out = new Out(op.opId);
  const specId = target(doc, op, out);
  if (entity) out.addFacet(specId, 'entity', entity.section, entityDraft(classes, entity.entities));
  if (classification) {
    // IDS 1.0 has no @uri in the applicability: the URI is kept only on a requirement.
    const withUri = classification.section === 'requirements' && classification.uri !== false;
    out.addFacet(specId, 'classification', classification.section, classificationDraft(classes, withUri));
  }
  return out.ops;
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Expansion of `bulk.fromBsddClass` (05-bsdd.md §2.1–2.3): bSDD classes →
 * an optional new specification, an entity facet, a classification facet.
 * Pure: the op carries class snapshots, ids derive from the op id.
 */

import { RESERVED_PSET_PREFIXES } from '@ifc-lite/data';
import { BsddMappingError, mapBsddProperty, type BsddPropertyMapping } from '../bsdd/mapping.js';
import { locateSpec } from '../document/node-index.js';
import type { StudioDocument } from '../document/types.js';
import type { CustomPsetDecl } from '../document/types.js';
import type { BsddClassSnapshot, BsddPropertySnapshot, BulkFromBsddClassOp, ConstraintDraft, FacetDraft, PrimitiveOp } from '../ops/types.js';
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

function findProperty(cls: BsddClassSnapshot, key: string): BsddPropertySnapshot | undefined {
  return cls.properties?.find((p) => p.code === key || p.uri === key);
}

/** The custom set declarations the mapped properties need (standard `Pset_`/`Qto_` sets are never declared). */
function declarations(doc: StudioDocument, mapped: readonly BsddPropertyMapping[]): CustomPsetDecl[] {
  const wanted = new Map<string, { name: string; dataType?: string }[]>();
  for (const m of mapped) {
    if (RESERVED_PSET_PREFIXES.some((prefix) => m.propertySet.startsWith(prefix))) continue;
    const list = wanted.get(m.propertySet) ?? [];
    list.push(m.dataType ? { name: m.baseName, dataType: m.dataType } : { name: m.baseName });
    wanted.set(m.propertySet, list);
  }
  const out: CustomPsetDecl[] = [];
  for (const [name, props] of wanted) {
    const existing = doc.meta.custom.psets.find((d) => d.name === name);
    if (existing && !existing.properties) continue; // an open declaration admits any property
    const known = new Set(existing?.properties?.map((p) => p.name));
    const added = props.filter((p) => !known.has(p.name));
    if (existing && added.length === 0) continue;
    out.push({ name, properties: [...(existing?.properties ?? []), ...added] });
  }
  return out;
}

/** Property requirements through the mapping table (IDS-071), after the set declarations they need. */
function expandProperties(doc: StudioDocument, op: BulkFromBsddClassOp, specId: Uuid, out: Out): void {
  const selection = op.payload.properties;
  if (!selection) return;
  const [first, ...rest] = op.payload.classes;
  const mapped: BsddPropertyMapping[] = [];
  for (const key of new Set(selection.select)) {
    const prop = findProperty(first, key);
    const missing = prop ? rest.find((c) => !findProperty(c, key)) : first;
    if (!prop || missing) throw new OpApplyError('GATE-OP-002', `property ${key} is not defined on bSDD class ${missing?.code ?? first.code}`);
    try {
      mapped.push(mapBsddProperty(prop, selection));
    } catch (err) {
      if (err instanceof BsddMappingError) throw new OpApplyError('GATE-OP-002', err.message);
      throw err;
    }
  }
  for (const decl of declarations(doc, mapped)) out.ops.push({ kind: 'meta.custom.declarePset', opId: out.nextId(), payload: { decl } });
  for (const m of mapped) out.addFacet(specId, `prop:${m.propertySet}:${m.baseName}`, 'requirements', m.facet, { optionality: m.optionality });
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
  expandProperties(doc, op, specId, out);
  return out.ops;
}

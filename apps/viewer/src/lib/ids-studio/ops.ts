/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Op builders for the Studio UI. Each returns plain `@ifc-lite/ids-authoring`
 * ops (nothing here touches a document); the caller dispatches them through
 * the gate. Minting ids here keeps components free of uuid plumbing.
 */

import {
  uuidv7,
  type FacetDraft,
  type FacetFieldName,
  type InfoField,
  type Scalar,
  type Section,
  type SpecCardinality,
  type SpecTextField,
  type StudioOp,
  type Uuid,
  type ValueInput,
} from '@ifc-lite/ids-authoring';
import type { IFCVersion, PartOfRelation, RequirementOptionality } from '@ifc-lite/ids';

/** Blank text clears an optional field (IDS omits empty attributes). */
const textOrNull = (value: string): string | null => (value.trim() ? value : null);

export function setInfoOp(field: InfoField, value: string): StudioOp {
  // `title` is required by IDS: keep an empty title as text so the gate/audit reports it.
  return { kind: 'doc.setInfo', opId: uuidv7(), payload: { field, value: field === 'title' ? value : textOrNull(value) } };
}

export function addSpecOps(options: { name: string; ifcVersions: IFCVersion[]; index?: number }): { ops: StudioOp[]; specId: Uuid } {
  const specId = uuidv7();
  const payload = { specId, name: options.name, ifcVersions: options.ifcVersions, ...(options.index === undefined ? {} : { index: options.index }) };
  return { ops: [{ kind: 'spec.add', opId: uuidv7(), payload }], specId };
}

export function setSpecTextOp(specId: Uuid, field: SpecTextField, value: string): StudioOp {
  return { kind: 'spec.set', opId: uuidv7(), payload: { specId, field, value: field === 'name' ? value : textOrNull(value) } };
}

export function setSpecCardinalityOp(specId: Uuid, cardinality: SpecCardinality): StudioOp {
  return { kind: 'spec.setCardinality', opId: uuidv7(), payload: { specId, cardinality } };
}

export function setSpecVersionsOp(specId: Uuid, versions: IFCVersion[]): StudioOp {
  return { kind: 'spec.setIfcVersions', opId: uuidv7(), payload: { specId, versions } };
}

export function removeSpecOp(specId: Uuid): StudioOp {
  return { kind: 'spec.remove', opId: uuidv7(), payload: { specId } };
}

export function duplicateSpecOps(specId: Uuid, nameSuffix: string): { ops: StudioOp[]; specId: Uuid } {
  const newSpecId = uuidv7();
  return { ops: [{ kind: 'spec.duplicate', opId: uuidv7(), payload: { specId, newSpecId, nameSuffix } }], specId: newSpecId };
}

export function moveSpecOp(specId: Uuid, toIndex: number): StudioOp {
  return { kind: 'spec.move', opId: uuidv7(), payload: { specId, toIndex } };
}

export function addFacetOps(specId: Uuid, section: Section, facet: FacetDraft, optionality?: RequirementOptionality): { ops: StudioOp[]; facetId: Uuid } {
  const facetId = uuidv7();
  const payload = { specId, section, facetId, facet, ...(section === 'requirements' && optionality ? { optionality } : {}) };
  return { ops: [{ kind: 'facet.add', opId: uuidv7(), payload }], facetId };
}

export function removeFacetOp(facetId: Uuid): StudioOp {
  return { kind: 'facet.remove', opId: uuidv7(), payload: { facetId } };
}

export function moveFacetOp(facetId: Uuid, toIndex: number): StudioOp {
  return { kind: 'facet.move', opId: uuidv7(), payload: { facetId, toIndex } };
}

/** `null` removes an optional field (a value, a predefinedType, a dataType). */
export function setFieldOp(facetId: Uuid, field: FacetFieldName, value: ValueInput | null): StudioOp {
  return { kind: 'facet.setField', opId: uuidv7(), payload: { facetId, field, value } };
}

export function setRelationOp(facetId: Uuid, relation: PartOfRelation): StudioOp {
  return { kind: 'facet.setRelation', opId: uuidv7(), payload: { facetId, relation } };
}

export function setOptionalityOp(facetId: Uuid, optionality: RequirementOptionality): StudioOp {
  return { kind: 'requirement.setOptionality', opId: uuidv7(), payload: { facetId, optionality } };
}

export function setRequirementTextOp(facetId: Uuid, field: 'description' | 'instructions', value: string): StudioOp {
  return { kind: 'requirement.set', opId: uuidv7(), payload: { facetId, field, value: textOrNull(value) } };
}

export function addEnumValueOp(facetId: Uuid, field: FacetFieldName, value: Scalar): StudioOp {
  return { kind: 'value.addEnumValue', opId: uuidv7(), payload: { facetId, field, value } };
}

export function removeEnumValueOp(facetId: Uuid, field: FacetFieldName, value: Scalar): StudioOp {
  return { kind: 'value.removeEnumValue', opId: uuidv7(), payload: { facetId, field, value } };
}

/**
 * Declare `name` as a custom (non-standard) property set. Only offered after
 * the gate refused the name as undeclared (GATE-CUST-001), so declaring is a
 * deliberate choice, never a silent fallback for a misspelt standard set.
 */
export function declarePsetOp(name: string): StudioOp {
  return { kind: 'meta.custom.declarePset', opId: uuidv7(), payload: { decl: { name } } };
}

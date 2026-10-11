/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Native target of each reviewed source requirement (#7375). P16 extracted
 * the requirement and verified its span; this decides, explicitly and
 * without a provider call, which native owner could check it: an IDS
 * specification, an information rule over a geometry-derived quantity
 * (`Qto_*`), a manual item in a native document, or nothing (unresolved,
 * with the reason). Nothing here builds, runs or saves a draft.
 */

import { xxhash64Hex } from '@ifc-lite/cache';
import type { ExtractedRequirement } from './requirement-proposal';
import type { SourceText } from './source-texts';
import type { Passage, SpanCheck } from './spans';

export type RequirementTarget = 'ids' | 'geometry' | 'manual' | 'unresolved';
export type UnresolvedReason = 'span' | 'source-missing' | 'source-changed' | 'scope' | 'property' | 'operator' | 'value' | 'unit' | 'native';

/** The attached text a verified span quotes, as it is now: its id, title and content revision. */
export interface SourceRevision { source: string; title: string; revision: string; characters: number }

export interface ClassifiedRequirement {
  requirement: ExtractedRequirement;
  check: SpanCheck;
  target: RequirementTarget;
  /** Why the requirement has no native target; set only for `unresolved`. */
  reason?: UnresolvedReason;
  /** The native validator's own refusal, for `native`. */
  detail?: string;
  /** Set whenever the span verified against an unchanged source, whatever the target. */
  source?: SourceRevision;
}

/** Portable content revision of an attached text, recorded with each native record for provenance. */
export function textRevision(text: string): string {
  return xxhash64Hex(new TextEncoder().encode(text));
}

/**
 * The attached source a span cites, checked against the passages frozen into
 * the conversation: every frozen passage of that source must still read the
 * same at the same offsets, otherwise the text changed after the assistant
 * saw it (detached, replaced or re-attached under the same id).
 */
export function sourceRevisionOf(id: string, passages: readonly Passage[], sources: readonly SourceText[]): SourceRevision | 'source-missing' | 'source-changed' {
  const source = sources.find(candidate => candidate.id === id);
  if (!source) return 'source-missing';
  const frozen = passages.filter(passage => passage.source === id);
  if (!frozen.length || frozen.some(passage => source.text.slice(passage.start, passage.end) !== passage.text)) return 'source-changed';
  return { source: id, title: source.title, revision: textRevision(source.text), characters: source.text.length };
}

/** IFC attributes an IDS attribute facet may require by name; any other bare property name is ambiguous. */
const IDS_ATTRIBUTES = new Set(['Name', 'Description', 'ObjectType', 'Tag', 'LongName', 'PredefinedType']);

export type PropertyTarget = { kind: 'attribute'; name: string } | { kind: 'property'; set: string; name: string };

/** `Pset_WallCommon.FireRating` or an IFC attribute name; anything else is not addressable natively. */
export function propertyTarget(property: string): PropertyTarget | null {
  const qualified = /^([A-Za-z][A-Za-z0-9_]{0,99})\.([A-Za-z][A-Za-z0-9_ ]{0,99})$/.exec(property.trim());
  if (qualified) return { kind: 'property', set: qualified[1], name: qualified[2].trim() };
  return IDS_ATTRIBUTES.has(property.trim()) ? { kind: 'attribute', name: property.trim() } : null;
}

const MEASURES = { length: 'IFCLENGTHMEASURE', area: 'IFCAREAMEASURE', volume: 'IFCVOLUMEMEASURE' } as const;

/** A stated unit in the spelling the native converters take (`m²` → `m2`), with its IFC measure type. */
export function measureUnit(unit: string): { unit: string; dataType: string } | null {
  const normal = unit.trim().replace('²', '2').replace('³', '3');
  const match = /^(mm|cm|m)([23]?)$/.exec(normal);
  if (!match) return null;
  return { unit: normal, dataType: MEASURES[match[2] === '2' ? 'area' : match[2] === '3' ? 'volume' : 'length'] };
}

const GEOMETRY_OPERATORS = new Set(['equals', 'notEquals', 'atLeast', 'atMost']);

/** Shape-level target; the native validators still have the last word (see `requirement-dispatch.ts`). */
export function classifyRequirement(requirement: ExtractedRequirement, check: SpanCheck, source: SourceRevision | 'source-missing' | 'source-changed'): ClassifiedRequirement {
  if (check.status !== 'verified') return { requirement, check, target: 'unresolved', reason: 'span' };
  if (typeof source === 'string') return { requirement, check, target: 'unresolved', reason: source };
  // From here the span verified against an unchanged source: every outcome keeps that provenance.
  const unresolved = (reason: UnresolvedReason): ClassifiedRequirement => ({ requirement, check, target: 'unresolved', reason, source });
  const resolved = (target: RequirementTarget): ClassifiedRequirement => ({ requirement, check, target, source });
  const { appliesTo, property, value, unit } = requirement;
  // Nothing names what to check on which elements: a person checks it, from the document.
  if (!appliesTo?.ifcClass || !property) return resolved('manual');
  // A linked-data class narrows the IFC class; checking the whole IFC class would widen the requirement.
  if (appliesTo.ontologyClass !== undefined) return unresolved('scope');
  const target = propertyTarget(property);
  if (!target) return unresolved('property');
  // A stated value with no comparison (or "exists") is never reduced to an existence check that drops it.
  if (value !== undefined && (requirement.operator === undefined || requirement.operator === 'exists')) return unresolved('value');
  const operator = requirement.operator ?? 'exists';
  if (target.kind === 'property' && target.set.startsWith('Qto_') && GEOMETRY_OPERATORS.has(operator)) {
    if (typeof value !== 'number') return unresolved('value');
    return unit !== undefined && measureUnit(unit) ? resolved('geometry') : unresolved('unit');
  }
  // IDS has no negated value constraint.
  if (operator === 'notEquals') return unresolved('operator');
  if ((operator === 'atLeast' || operator === 'atMost') && typeof value !== 'number') return unresolved('value');
  if (operator === 'matches' && typeof value !== 'string') return unresolved('value');
  if (operator === 'oneOf' && !Array.isArray(value)) return unresolved('value');
  if (operator === 'equals' && (Array.isArray(value) || value === undefined)) return unresolved('value');
  if (unit !== undefined && operator !== 'exists') {
    if (target.kind === 'attribute' || !measureUnit(unit)) return unresolved('unit');
    if (Array.isArray(value) ? !value.every(item => typeof item === 'number') : typeof value !== 'number') return unresolved('unit');
  }
  return resolved('ids');
}

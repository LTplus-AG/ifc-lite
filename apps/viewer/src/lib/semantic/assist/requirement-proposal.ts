/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { onlyKeys, parseEnvelope, parseSpan, parseUnsupported, record, text, type SourceSpan, type UnsupportedItem } from './proposal-common';

export const REQUIREMENT_OPERATORS = ['equals', 'notEquals', 'atLeast', 'atMost', 'exists', 'oneOf', 'matches'] as const;
export type RequirementOperator = typeof REQUIREMENT_OPERATORS[number];

/** One structured requirement, always anchored to the exact passage it came from. */
export interface ExtractedRequirement {
  id: string; statement: string;
  appliesTo?: { ifcClass?: string; ontologyClass?: string };
  property?: string; operator?: RequirementOperator; value?: string | number | boolean | Array<string | number>; unit?: string;
  span: SourceSpan;
}
export interface SemanticRequirementProposal {
  version: 1; kind: 'semantic.requirements'; title: string; requirements: ExtractedRequirement[]; unsupported: UnsupportedItem[];
}

const scalar = (value: unknown) => (typeof value === 'string' && value.length <= 400) || typeof value === 'boolean'
  || (typeof value === 'number' && Number.isFinite(value));

function requirement(value: unknown, index: number, ids: Set<string>): ExtractedRequirement {
  const at = `Requirement ${index + 1}`;
  if (!record(value)) throw new Error(`${at} is not an object`);
  onlyKeys(value, ['id', 'statement', 'appliesTo', 'property', 'operator', 'value', 'unit', 'span'], at);
  if (typeof value.id !== 'string' || !/^[A-Za-z0-9_.-]{1,40}$/.test(value.id) || ids.has(value.id)) throw new Error(`${at} needs a unique short id`);
  ids.add(value.id);
  if (!text(value.statement, 1000)) throw new Error(`${at} needs a statement`);
  let appliesTo: ExtractedRequirement['appliesTo'];
  if (value.appliesTo !== undefined) {
    if (!record(value.appliesTo)) throw new Error(`${at} appliesTo must be an object`);
    onlyKeys(value.appliesTo, ['ifcClass', 'ontologyClass'], `${at} appliesTo`);
    const { ifcClass, ontologyClass } = value.appliesTo;
    if (ifcClass !== undefined && (typeof ifcClass !== 'string' || !/^Ifc[A-Za-z0-9]{1,80}$/.test(ifcClass))) throw new Error(`${at} ifcClass must be an IFC class name`);
    if (ontologyClass !== undefined && !text(ontologyClass, 1000)) throw new Error(`${at} ontologyClass must be text`);
    appliesTo = { ...(ifcClass === undefined ? {} : { ifcClass: ifcClass as string }), ...(ontologyClass === undefined ? {} : { ontologyClass: ontologyClass as string }) };
  }
  if (value.property !== undefined && !text(value.property, 400)) throw new Error(`${at} property must be text`);
  if (value.operator !== undefined && !REQUIREMENT_OPERATORS.includes(value.operator as RequirementOperator)) {
    throw new Error(`${at} operator must be one of ${REQUIREMENT_OPERATORS.join(', ')}`);
  }
  if (value.value !== undefined && !scalar(value.value)
    && !(Array.isArray(value.value) && value.value.length <= 50 && value.value.every(item => typeof item !== 'boolean' && scalar(item)))) {
    throw new Error(`${at} value must be text, a number, a boolean or a short list`);
  }
  if (value.operator !== undefined && value.operator !== 'exists' && value.value === undefined) throw new Error(`${at} operator "${String(value.operator)}" needs a value`);
  if (value.unit !== undefined && !text(value.unit, 60)) throw new Error(`${at} unit must be text`);
  return { id: value.id, statement: value.statement, ...(appliesTo ? { appliesTo } : {}),
    ...(value.property === undefined ? {} : { property: value.property as string }),
    ...(value.operator === undefined ? {} : { operator: value.operator as RequirementOperator }),
    ...(value.value === undefined ? {} : { value: value.value as ExtractedRequirement['value'] }),
    ...(value.unit === undefined ? {} : { unit: value.unit as string }), span: parseSpan(value.span, at) };
}

export function parseSemanticRequirements(answer: string): SemanticRequirementProposal {
  const value = parseEnvelope(answer, 'semantic.requirements', ['requirements', 'unsupported']);
  if (!Array.isArray(value.requirements) || value.requirements.length > 200) throw new Error('"requirements" must be a list of at most 200 items');
  const ids = new Set<string>();
  const requirements = value.requirements.map((item, index) => requirement(item, index, ids));
  const unsupported = parseUnsupported(value.unsupported);
  if (!requirements.length && !unsupported.length) throw new Error('Extract at least one requirement or retain an unsupported passage');
  return { version: 1, kind: 'semantic.requirements', title: (value.title as string).trim(), requirements, unsupported };
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ConstraintDraft` → `IDSConstraint` normalisation (§3.4) and
 * `FacetDraft` → `IDSFacet`.
 *
 * Rules:
 * - `any` means "no value check": the field is removed (IDS expresses "any
 *   value" by omitting the constraint). Required fields cannot be `any`.
 * - `equals` → `simpleValue`; booleans become `true`/`false`.
 * - `oneOf` → `enumeration`; an all-number list gets base `xs:double`, an
 *   all-boolean list `xs:boolean`, unless `base` is given.
 * - `range` → `bounds` (in/exclusive per flag, inclusive by default), the
 *   unit converted to SI.
 * - `length` / `digits` → `bounds` length / digit facets.
 * - `all` → one restriction: bounds merge into one family, the first family
 *   is primary and the rest hang off `and` (the `@ifc-lite/ids` shape).
 * - Literal entity names and dataTypes are stored UPPERCASE, as in IDS XML.
 */

import type { IDSBoundsConstraint, IDSConstraint, IDSFacet } from '@ifc-lite/ids';
import type { FacetFieldName } from '../document/fields.js';
import type { ConstraintDraft, FacetDraft, Scalar, ValueInput } from './types.js';
import { toSI } from './units.js';

/** A draft that cannot be normalised. Surfaces as gate code `GATE-VAL-001`. */
export class DraftError extends Error {
  readonly code = 'GATE-VAL-001';
  constructor(message: string) {
    super(message);
    this.name = 'DraftError';
  }
}

const UPPERCASE_FIELDS: ReadonlySet<FacetFieldName> = new Set<FacetFieldName>([
  'entity.name',
  'partOf.entity.name',
  'property.dataType',
]);

function scalarToString(v: Scalar): string {
  if (typeof v === 'number' && !Number.isFinite(v)) throw new DraftError('numbers must be finite');
  return String(v);
}

function finite(n: number | undefined, what: string): number | undefined {
  if (n !== undefined && !Number.isFinite(n)) throw new DraftError(`${what} must be a finite number`);
  return n;
}

function inferBase(values: Scalar[]): string | undefined {
  if (values.every((v) => typeof v === 'number')) return 'xs:double';
  if (values.every((v) => typeof v === 'boolean')) return 'xs:boolean';
  return undefined;
}

function normaliseDraft(draft: ConstraintDraft): IDSConstraint | undefined {
  switch (draft.kind) {
    case 'any':
      return undefined;
    case 'equals':
      return { type: 'simpleValue', value: scalarToString(draft.value) };
    case 'oneOf': {
      if (draft.values.length === 0) throw new DraftError('oneOf needs at least one value');
      const values = [...new Set(draft.values.map(scalarToString))];
      const base = draft.base ?? inferBase(draft.values);
      return base ? { type: 'enumeration', values, base } : { type: 'enumeration', values };
    }
    case 'pattern':
      return draft.base
        ? { type: 'pattern', pattern: draft.pattern, base: draft.base }
        : { type: 'pattern', pattern: draft.pattern };
    case 'range': {
      const conv = (n: number | undefined, what: string): number | undefined => {
        const v = finite(n, what);
        return v === undefined || draft.unit === undefined ? v : toSIOrThrow(v, draft.unit);
      };
      const min = conv(draft.min, 'min');
      const max = conv(draft.max, 'max');
      if (min === undefined && max === undefined) throw new DraftError('range needs min or max');
      const out: IDSBoundsConstraint = { type: 'bounds' };
      if (min !== undefined) {
        if (draft.minInclusive === false) out.minExclusive = min;
        else out.minInclusive = min;
      }
      if (max !== undefined) {
        if (draft.maxInclusive === false) out.maxExclusive = max;
        else out.maxInclusive = max;
      }
      if (draft.base) out.base = draft.base;
      return out;
    }
    case 'length': {
      if (draft.exact === undefined && draft.min === undefined && draft.max === undefined) {
        throw new DraftError('length needs exact, min or max');
      }
      if (draft.exact !== undefined && (draft.min !== undefined || draft.max !== undefined)) {
        throw new DraftError('length takes either exact or min/max');
      }
      const out: IDSBoundsConstraint = { type: 'bounds' };
      if (draft.exact !== undefined) out.length = draft.exact;
      if (draft.min !== undefined) out.minLength = draft.min;
      if (draft.max !== undefined) out.maxLength = draft.max;
      return out;
    }
    case 'digits': {
      if (draft.total === undefined && draft.fraction === undefined) {
        throw new DraftError('digits needs total or fraction');
      }
      const out: IDSBoundsConstraint = { type: 'bounds' };
      if (draft.total !== undefined) out.totalDigits = draft.total;
      if (draft.fraction !== undefined) out.fractionDigits = draft.fraction;
      return out;
    }
    case 'all':
      return normaliseAll(draft.of);
  }
}

function toSIOrThrow(value: number, unit: string): number {
  try {
    return toSI(value, unit);
  } catch (err) {
    throw new DraftError(err instanceof Error ? err.message : String(err));
  }
}

const BOUND_KEYS = [
  'minInclusive',
  'maxInclusive',
  'minExclusive',
  'maxExclusive',
  'length',
  'minLength',
  'maxLength',
  'totalDigits',
  'fractionDigits',
] as const;

function normaliseAll(parts: ConstraintDraft[]): IDSConstraint {
  if (parts.length === 0) throw new DraftError('all needs at least one constraint');
  const families: IDSConstraint[] = [];
  let bounds: IDSBoundsConstraint | undefined;
  let base: string | undefined;
  for (const part of parts) {
    const c = normaliseDraft(part);
    if (!c) throw new DraftError('all cannot contain any');
    if (c.type !== 'simpleValue' && c.and?.length) throw new DraftError('all cannot nest all');
    if (c.type !== 'simpleValue' && c.base) {
      if (base && base !== c.base) throw new DraftError(`conflicting bases ${base} and ${c.base}`);
      base = c.base;
    }
    if (c.type === 'bounds') {
      if (!bounds) {
        bounds = { type: 'bounds' };
        families.push(bounds);
      }
      for (const key of BOUND_KEYS) {
        if (c[key] === undefined) continue;
        if (bounds[key] !== undefined) throw new DraftError(`all sets ${key} twice`);
        bounds[key] = c[key];
      }
      continue;
    }
    // A literal inside a conjunction is a one-value enumeration (an
    // IDSSimpleValue cannot carry siblings).
    families.push(c.type === 'simpleValue' ? { type: 'enumeration', values: [c.value] } : { ...c });
  }
  const [primary, ...rest] = families;
  const out = { ...primary } as Exclude<IDSConstraint, { type: 'simpleValue' }>;
  delete out.base;
  if (base) out.base = base;
  for (const r of rest) if (r.type !== 'simpleValue') delete r.base;
  if (rest.length > 0) out.and = rest;
  return out;
}

function upper(c: IDSConstraint): IDSConstraint {
  if (c.type === 'simpleValue') return { ...c, value: c.value.toUpperCase() };
  if (c.type === 'enumeration') return { ...c, values: c.values.map((v) => v.toUpperCase()) };
  return c;
}

/**
 * Normalise a value input for `field`. Returns `undefined` for `any`
 * (remove the constraint). Raw constraints pass through unchanged.
 */
export function normaliseValue(input: ValueInput, field?: FacetFieldName): IDSConstraint | undefined {
  if (input.kind === 'raw') return input.constraint;
  const c = normaliseDraft(input);
  return c && field && UPPERCASE_FIELDS.has(field) ? upper(c) : c;
}

function required(input: ValueInput, field: FacetFieldName): IDSConstraint {
  const c = normaliseValue(input, field);
  if (!c) throw new DraftError(`${field} is required and cannot be "any"`);
  return c;
}

function optional<K extends string>(
  key: K,
  input: ValueInput | undefined,
  field: FacetFieldName,
): Partial<Record<K, IDSConstraint>> {
  const c = input ? normaliseValue(input, field) : undefined;
  return c ? ({ [key]: c } as Record<K, IDSConstraint>) : {};
}

function uriOf(uri: string | undefined): { uri?: string } {
  return uri ? { uri } : {};
}

/** Build the IDS facet a draft describes. Throws `DraftError`. */
export function facetFromDraft(draft: FacetDraft): IDSFacet {
  switch (draft.type) {
    case 'entity':
      return {
        type: 'entity',
        name: required(draft.name, 'entity.name'),
        ...optional('predefinedType', draft.predefinedType, 'entity.predefinedType'),
      };
    case 'attribute':
      return {
        type: 'attribute',
        name: required(draft.name, 'attribute.name'),
        ...optional('value', draft.value, 'attribute.value'),
      };
    case 'property':
      return {
        type: 'property',
        propertySet: required(draft.propertySet, 'property.propertySet'),
        baseName: required(draft.baseName, 'property.baseName'),
        ...optional('dataType', draft.dataType, 'property.dataType'),
        ...optional('value', draft.value, 'property.value'),
        ...uriOf(draft.uri),
      };
    case 'classification':
      return {
        type: 'classification',
        ...optional('system', draft.system, 'classification.system'),
        ...optional('value', draft.value, 'classification.value'),
        ...uriOf(draft.uri),
      };
    case 'material':
      return { type: 'material', ...optional('value', draft.value, 'material.value'), ...uriOf(draft.uri) };
    case 'partOf': {
      if (!draft.entity) return { type: 'partOf', relation: draft.relation };
      return {
        type: 'partOf',
        relation: draft.relation,
        entity: {
          type: 'entity',
          name: required(draft.entity.name, 'partOf.entity.name'),
          ...optional('predefinedType', draft.entity.predefinedType, 'partOf.entity.predefinedType'),
        },
      };
    }
  }
}

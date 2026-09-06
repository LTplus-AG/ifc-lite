/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS property-requirement correction (#3929).
 *
 * Scope, per the issue: one scalar property requirement at a time, on a
 * user-supplied value, applied through the canonical mutation path
 * (`MutablePropertyView.setProperty`, the same primitive the Bulk Property
 * Editor's `BulkQueryEngine.applyAction('SET_PROPERTY')` calls). No
 * automatic invention of compliant values, no geometry edits, no general
 * repair — the caller always supplies the replacement value.
 *
 * This module is intentionally pure/framework-free so the eligibility and
 * value-typing rules are unit-testable without a mounted component or a
 * real IfcDataStore.
 */

import { PropertyValueType } from '@ifc-lite/data';
import type { PropertyValue } from '@ifc-lite/mutations';
import type {
  IDSConstraint,
  IDSRequirementResult,
} from '@ifc-lite/ids';

// ============================================================================
// Eligibility
// ============================================================================

export interface CorrectionTarget {
  /** Exact property-set name to write to (case-sensitive). */
  psetName: string;
  /** Exact property name to write (case-sensitive). */
  propName: string;
}

export type CorrectionEligibility =
  | ({ eligible: true } & CorrectionTarget)
  | { eligible: false; reason: string };

/**
 * A property/pset name constraint is only correctable when it names an
 * EXACT string. A pattern or enumeration constraint means "any property
 * matching X" — there is no single target to write, so we refuse rather
 * than guess (the substring/exact-match discipline this codebase requires
 * for name comparisons, applied here to constraint *shape* rather than
 * a runtime string).
 */
function exactNameOf(constraint: IDSConstraint | undefined): string | null {
  if (!constraint) return null;
  return constraint.type === 'simpleValue' ? constraint.value : null;
}

/**
 * Determine whether a failed requirement result is a correctable "scalar
 * property requirement" and, if so, the exact pset/property it targets.
 *
 * Deliberately narrow: only `type: 'property'` facets with an exact
 * (simpleValue) property-set name and property name, on a `required` or
 * `optional` requirement that actually failed. Everything else — other
 * facet types, pattern/enumeration name constraints, prohibited
 * requirements (satisfied by removing a value, not setting one), and
 * already-passing requirements — is rejected with a stated reason so the
 * caller can surface it rather than silently offering a broken action.
 */
export function checkCorrectionEligibility(
  result: IDSRequirementResult,
): CorrectionEligibility {
  if (result.status !== 'fail') {
    return { eligible: false, reason: 'This requirement did not fail — there is nothing to correct.' };
  }
  if (result.facetType !== 'property' || result.requirement.facet.type !== 'property') {
    return {
      eligible: false,
      reason: `Only property requirements can be corrected here (this is a "${result.facetType}" requirement).`,
    };
  }
  if (result.requirement.optionality === 'prohibited') {
    return {
      eligible: false,
      reason: 'A prohibited requirement is satisfied by removing the property, not setting a value — not supported here.',
    };
  }

  const facet = result.requirement.facet;
  const psetName = exactNameOf(facet.propertySet);
  if (psetName == null) {
    return {
      eligible: false,
      reason: 'The property set name uses a pattern or enumeration, not an exact name — the target set is ambiguous.',
    };
  }
  const propName = exactNameOf(facet.baseName);
  if (propName == null) {
    return {
      eligible: false,
      reason: 'The property name uses a pattern or enumeration, not an exact name — the target property is ambiguous.',
    };
  }

  return { eligible: true, psetName, propName };
}

// ============================================================================
// Value typing
// ============================================================================

/**
 * Infer the `PropertyValueType` to write the correction as. Prefers the
 * entity's OWN current dataType for the property (so a correction of an
 * existing wrong value preserves its IFC type exactly, per the issue's
 * "preserve IFC property typing"). Falls back to the IDS facet's declared
 * `dataType` constraint (only present for a PROPERTY_MISSING case, where
 * there is no existing value to read a type from). Defaults to `String`
 * — the least destructive assumption when neither is available.
 */
export function inferValueType(
  existingDataType: string | undefined,
  idsDataType: string | undefined,
): PropertyValueType {
  const dt = (existingDataType || idsDataType || '').toUpperCase();
  if (dt.includes('BOOLEAN') || dt.includes('LOGICAL')) return PropertyValueType.Boolean;
  if (dt.includes('INTEGER') || dt.includes('COUNT')) return PropertyValueType.Integer;
  if (
    dt.includes('REAL')
    || dt.includes('MEASURE')
    || dt.includes('NUMBER')
    || dt.includes('RATIO')
  ) {
    return PropertyValueType.Real;
  }
  if (dt.includes('IDENTIFIER')) return PropertyValueType.Identifier;
  if (dt.includes('TEXT')) return PropertyValueType.Text;
  if (dt.includes('LABEL')) return PropertyValueType.Label;
  return PropertyValueType.String;
}

/** Thrown by {@link parseCorrectionValue} when the raw input can't be parsed as the target type. */
export class CorrectionValueError extends Error {}

/**
 * Parse the user-supplied replacement string into the value the target
 * `PropertyValueType` expects. Never invents a value — an unparsable
 * input throws so the caller can surface it instead of silently writing
 * a wrong-typed (and therefore re-failing) property.
 */
export function parseCorrectionValue(
  raw: string,
  valueType: PropertyValueType,
): string | number | boolean {
  const trimmed = raw.trim();
  switch (valueType) {
    case PropertyValueType.Real: {
      const n = Number(trimmed);
      if (trimmed.length === 0 || !Number.isFinite(n)) {
        throw new CorrectionValueError(`"${raw}" is not a valid number`);
      }
      return n;
    }
    case PropertyValueType.Integer: {
      const n = Number(trimmed);
      if (trimmed.length === 0 || !Number.isInteger(n)) {
        throw new CorrectionValueError(`"${raw}" is not a valid integer`);
      }
      return n;
    }
    case PropertyValueType.Boolean: {
      const lower = trimmed.toLowerCase();
      if (lower === 'true' || lower === '1' || lower === 'yes') return true;
      if (lower === 'false' || lower === '0' || lower === 'no') return false;
      throw new CorrectionValueError(`"${raw}" is not a valid boolean (use true/false)`);
    }
    default:
      return raw;
  }
}

// ============================================================================
// Apply + verify (the canonical mutation path)
// ============================================================================

/** Minimal shape of `MutablePropertyView` this module writes through. */
export interface PropertyMutationSink {
  setProperty(
    entityId: number,
    psetName: string,
    propName: string,
    value: PropertyValue,
    valueType?: PropertyValueType,
  ): unknown;
  getPropertyValue(entityId: number, psetName: string, propName: string): PropertyValue | null;
}

export interface CorrectionApplyResult {
  expressId: number;
  applied: boolean;
  /** Set when `applied` is false — always shown to the user, never swallowed. */
  error?: string;
}

/**
 * Apply one property correction to one entity through the canonical
 * mutation path, then read the value straight back from the SAME view
 * to confirm the write actually stuck. A correction that appears to
 * succeed but didn't take effect (wrong key, an overlay that silently
 * no-ops, a mismatched pset case) is this codebase's most common defect
 * shape — so success is only ever reported after a verified read-back,
 * never on "the call didn't throw."
 */
export function applyPropertyCorrection(
  sink: PropertyMutationSink,
  expressId: number,
  target: CorrectionTarget,
  value: string | number | boolean,
  valueType: PropertyValueType,
): CorrectionApplyResult {
  try {
    sink.setProperty(expressId, target.psetName, target.propName, value, valueType);
  } catch (err) {
    return {
      expressId,
      applied: false,
      error: err instanceof Error ? err.message : 'Unknown error applying correction',
    };
  }

  const readBack = sink.getPropertyValue(expressId, target.psetName, target.propName);
  if (readBack !== value) {
    return {
      expressId,
      applied: false,
      error: `Correction did not take effect (expected "${String(value)}", read back "${String(readBack)}")`,
    };
  }
  return { expressId, applied: true };
}

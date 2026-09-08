/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `--where` filter parsing and evaluation for `ifc-lite query`. Split out of
 * `query.ts` (module-size ratchet) — this half is the filter language, the
 * rest of that file is the command's flag handling and output shaping.
 */

import {
  findAllPropertiesInSets,
  findAllQuantitiesInSets,
  compareFilterValue,
  normalizeBooleanValue,
  type FilterComparisonOp,
} from '@ifc-lite/query';
import { fatal } from '../output.js';

/**
 * Parse a --where filter string into psetName, propName, operator, value.
 * Supported formats:
 *   PsetName.PropName=Value     (equals)
 *   PsetName.PropName!=Value    (not equals)
 *   PsetName.PropName>Value     (greater than)
 *   PsetName.PropName<Value     (less than)
 *   PsetName.PropName>=Value    (greater or equal)
 *   PsetName.PropName<=Value    (less or equal)
 *   PsetName.PropName~Value     (contains)
 *   PsetName.PropName           (exists)
 */
export function parseWhereFilter(filter: string): { psetName: string; propName: string; operator: string; value?: string } {
  const dotIdx = filter.indexOf('.');
  if (dotIdx <= 0) {
    fatal(`Invalid --where syntax: "${filter}". Expected: PsetName.PropName[=Value]`);
  }

  const psetName = filter.slice(0, dotIdx);
  const rest = filter.slice(dotIdx + 1);

  // Try multi-char operators first, then single-char
  for (const op of ['!=', '>=', '<=', '>', '<', '=', '~']) {
    const opIdx = rest.indexOf(op);
    if (opIdx > 0) {
      const propName = rest.slice(0, opIdx);
      const value = rest.slice(opIdx + op.length);
      const mappedOp = op === '~' ? 'contains' : op;
      return { psetName, propName, operator: mappedOp, value };
    }
  }

  // No operator found — exists check
  return { psetName, propName: rest, operator: 'exists' };
}

/**
 * B3/F1: Apply --where filter to entities, searching both property sets AND quantity sets.
 * Falls back to quantity sets when a property set match is not found.
 *
 * Any-match, not first-match: an entity can legitimately carry two distinct
 * property (or quantity) sets sharing the same name — e.g. one from the type
 * definition and one from the occurrence (see `packages/query/src/pset-lookup.ts`).
 * A filter is a predicate over the entity, so it passes when ANY same-named
 * set satisfies the condition, even if an earlier same-named set does not
 * (#3490). This applies uniformly to every operator, `!=` included: `!=`
 * asks "does some occurrence of this property have a different value", the
 * same any-match shape `EntityQuery.whereProperty` already uses via
 * `matchesPsetFilter`/`matchesQsetFilter`.
 */
export function applyWhereFilter(entities: any[], parsed: ReturnType<typeof parseWhereFilter>, bim: any): any[] {
  return entities.filter(e => {
    // First try property sets
    const props = bim.properties(e.ref);
    const matchingProps = findAllPropertiesInSets<any>(props, parsed.psetName, parsed.propName);
    if (matchingProps.length > 0) {
      if (parsed.operator === 'exists') return true;
      return matchingProps.some(prop => compareValues(prop.value, parsed.operator, parsed.value));
    }

    // B3: Also search quantity sets
    const qsets = bim.quantities(e.ref);
    const matchingQtys = findAllQuantitiesInSets<any>(qsets, parsed.psetName, parsed.propName);
    if (matchingQtys.length > 0) {
      if (parsed.operator === 'exists') return true;
      return matchingQtys.some(qty => compareValues(qty.value, parsed.operator, parsed.value));
    }

    return false;
  });
}

// Delegates to @ifc-lite/query's shared compareFilterValue/normalizeBooleanValue
// (the same comparison the viewer SDK adapter, CLI HeadlessBackend, and MCP
// backend use for their QueryBackendMethods `where`), so `--where` can't drift
// from `bim.query().where(...)` semantics again.
export function compareValues(actual: any, operator: string, expected: string | undefined): boolean {
  if (expected === undefined) return actual != null;
  return compareFilterValue(actual, operator as FilterComparisonOp, expected);
}

export { normalizeBooleanValue };

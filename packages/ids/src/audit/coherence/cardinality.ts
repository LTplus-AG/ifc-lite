/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Requirement `@cardinality` coherence checks — split out of
 * `coherence/index.ts` (module-size budget).
 */

import type { IDSConstraint, IDSRequirement } from '../../types.js';
import type { IDSAuditIssue } from '../types.js';

/**
 * Cardinality coherence on a requirement facet (Report 202 upstream).
 *
 * Per upstream IDS-Audit-tool:
 *  - `cardinality="optional"` on a `<property>` requires `@dataType`.
 *  - `cardinality="prohibited"` on a `<property>` is incompatible with
 *    `@dataType` (the property must not exist at all).
 *  - `cardinality="optional"` on `<material>`, `<classification>` and
 *    `<partOf>` requires a value/system/entity to be specified — an
 *    `optional` facet without a constraint is meaningless.
 */
export function auditRequirementCardinality(
  req: IDSRequirement,
  path: string,
  issues: IDSAuditIssue[]
): void {
  // The XSD `conditionalCardinality` / `simpleCardinality` enums are
  // case-sensitive lowercase: `required`, `optional`, `prohibited`. The
  // parser preserves the raw value when it didn't match exactly so we
  // can flag mistakes here (`Required`, `Invalid`, empty string, …)
  // rather than silently defaulting to `required`.
  if (req.cardinalityRaw !== undefined) {
    // <partOf> takes ids:simpleCardinality ({required, prohibited}) — see the
    // partOf case below; every other facet takes the three-value
    // conditionalCardinality. Report the set that is actually allowed here.
    const expected =
      req.facet.type === 'partOf'
        ? '{required, prohibited}'
        : '{required, optional, prohibited}';
    issues.push({
      severity: 'error',
      code: 'E_CARDINALITY_INVALID',
      message: `@cardinality="${req.cardinalityRaw}" is not a valid value; expected one of ${expected}`,
      path: `${path}.cardinality`,
      facetType: req.facet.type,
      detail: { value: req.cardinalityRaw },
    });
  }
  switch (req.facet.type) {
    case 'property': {
      const hasDataType = req.facet.dataType !== undefined;
      if (req.optionality === 'optional' && !hasDataType) {
        issues.push({
          severity: 'error',
          code: 'E_CARDINALITY_INVALID',
          message:
            'optional <property> requirement requires @dataType to be specified',
          path: `${path}.cardinality`,
          facetType: 'property',
        });
      }
      if (req.optionality === 'prohibited' && hasDataType) {
        issues.push({
          severity: 'error',
          code: 'E_CARDINALITY_INVALID',
          message:
            'prohibited <property> requirement is incompatible with @dataType',
          path: `${path}.cardinality`,
          facetType: 'property',
        });
      }
      break;
    }
    case 'material': {
      if (req.optionality === 'optional') {
        const hasValue =
          req.facet.value !== undefined && !isEmptyConstraint(req.facet.value);
        if (!hasValue) {
          issues.push({
            severity: 'error',
            code: 'E_CARDINALITY_INVALID',
            message:
              'optional <material> requirement must specify a non-empty <value> constraint',
            path: `${path}.cardinality`,
            facetType: 'material',
          });
        }
      }
      break;
    }
    case 'classification': {
      if (req.optionality === 'optional') {
        const hasSystem =
          req.facet.system !== undefined &&
          !isEmptyConstraint(req.facet.system);
        const hasValue =
          req.facet.value !== undefined && !isEmptyConstraint(req.facet.value);
        if (!hasSystem && !hasValue) {
          issues.push({
            severity: 'error',
            code: 'E_CARDINALITY_INVALID',
            message:
              'optional <classification> requirement must specify <system> or <value>',
            path: `${path}.cardinality`,
            facetType: 'classification',
          });
        }
      }
      break;
    }
    case 'partOf':
      // <partOf> is ids:simpleCardinality ({required, prohibited}) in
      // ids.xsd, not the other facets' three-value conditionalCardinality.
      // "optional" passes the generic value check above (it IS one of the
      // three canonical tokens) but is still invalid for this facet.
      if (req.optionality === 'optional') {
        issues.push({
          severity: 'error',
          code: 'E_CARDINALITY_INVALID',
          message:
            '<partOf> cardinality="optional" is invalid; only required or prohibited (ids:simpleCardinality)',
          path: `${path}.cardinality`,
          facetType: 'partOf',
        });
      }
      break;
    case 'attribute':
    case 'entity':
      break;
  }
}

function isEmptyConstraint(c: IDSConstraint): boolean {
  switch (c.type) {
    case 'simpleValue':
      return c.value === '' || c.value == null;
    case 'enumeration':
      return c.values.length === 0;
    case 'pattern':
      return c.pattern === '';
    case 'bounds':
      return (
        c.minInclusive === undefined &&
        c.maxInclusive === undefined &&
        c.minExclusive === undefined &&
        c.maxExclusive === undefined &&
        c.length === undefined &&
        c.minLength === undefined &&
        c.maxLength === undefined
      );
  }
}

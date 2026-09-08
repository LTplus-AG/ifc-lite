/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Human-readable rendering of an IDS constraint in the report locale,
 * plus the parameter interpolation the whole translation service uses.
 *
 * Split out of `service.ts`, which delegates to both, so the facet
 * wording and the constraint wording can grow independently.
 */

import type { IDSConstraint } from '../types.js';
import type { en } from './locales/en.js';

type Translations = typeof en;

/** Interpolate `{name}` placeholders in a locale string. */
export function interpolate(
  template: string,
  params: Record<string, string | number>
): string {
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    if (key in params) {
      return String(params[key]);
    }
    return match;
  });
}

/**
 * Describe a constraint value in human-readable form.
 */
export function describeConstraint(
  constraint: IDSConstraint,
  t: Translations
): string {
  const own = describeOneFamily(constraint, t);
  // Facets from the same `<xs:restriction>` are conjunctive and all of
  // them are enforced, so describing only the primary would state a
  // weaker requirement to the reader than the one being checked.
  const siblings =
    constraint.type === 'simpleValue' ? undefined : constraint.and;
  if (siblings === undefined) return own;
  return siblings.reduce(
    (acc, sibling) =>
      interpolate(t.constraints.conjunction, {
        first: acc,
        second: describeOneFamily(sibling, t),
      }),
    own
  );
}

function describeOneFamily(constraint: IDSConstraint, t: Translations): string {
  switch (constraint.type) {
    case 'simpleValue':
      return interpolate(t.constraints.simpleValue, {
        value: constraint.value,
      });

    case 'pattern':
      return interpolate(t.constraints.pattern, {
        pattern: constraint.pattern,
      });

    case 'enumeration':
      if (constraint.values.length === 1) {
        return interpolate(t.constraints.enumeration.single, {
          value: constraint.values[0]!,
        });
      }
      return interpolate(t.constraints.enumeration.multiple, {
        values: constraint.values.map((v) => `"${v}"`).join(', '),
      });

    case 'bounds':
      return describeBounds(constraint, t);

    default:
      return 'unknown constraint';
  }
}

function describeBounds(
  constraint: IDSConstraint & { type: 'bounds' },
  translations: Translations
): string {
  const t = translations.constraints.bounds;

  if (
    constraint.minInclusive !== undefined &&
    constraint.maxInclusive !== undefined
  ) {
    return interpolate(t.between, {
      min: constraint.minInclusive,
      max: constraint.maxInclusive,
    });
  }

  if (constraint.minInclusive !== undefined) {
    return interpolate(t.atLeast, { min: constraint.minInclusive });
  }

  if (constraint.maxInclusive !== undefined) {
    return interpolate(t.atMost, { max: constraint.maxInclusive });
  }

  if (constraint.minExclusive !== undefined) {
    return interpolate(t.greaterThan, { min: constraint.minExclusive });
  }

  if (constraint.maxExclusive !== undefined) {
    return interpolate(t.lessThan, { max: constraint.maxExclusive });
  }

  return 'any value';
}

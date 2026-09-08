/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Match an IFC type name against a selector pattern.
 *
 * Grammar (case-insensitive):
 * - `*`               matches everything
 * - `IfcWall`         exact match
 * - `IfcPipe*`        wildcard suffix
 * - `IfcWall|IfcSlab` pipe-separated alternatives
 * - `!IfcWall`        exclusion (everything except)
 */
export function matchesSelector(typeName: string, selector: string): boolean {
  const trimmed = selector.trim();
  if (!trimmed || trimmed === '*') {
    return true;
  }

  const alternatives = trimmed.split('|');
  const upper = typeName.toUpperCase();

  // Pure negation list (e.g. "!IfcWall" or "!IfcWall|!IfcSlab"): read
  // literally as an OR of negations this would be a tautology for any
  // single input (nothing is both A and B), so a list where every
  // alternative is an exclusion is instead treated as an implicit AND of
  // exclusions -- "match everything except A and except B". This also
  // covers the single-exclusion case ("!IfcWall" means everything but
  // IfcWall).
  const nonEmptyAlternatives = alternatives.map((alt) => alt.trim()).filter((alt) => alt.length > 0);
  const isPureNegationList =
    nonEmptyAlternatives.length > 0 && nonEmptyAlternatives.every((alt) => alt.startsWith('!'));
  if (isPureNegationList) {
    for (const alt of nonEmptyAlternatives) {
      const pattern = alt.slice(1).toUpperCase();
      if (!pattern) continue;
      if (upper === pattern || (pattern.endsWith('*') && upper.startsWith(pattern.slice(0, -1)))) {
        return false;
      }
    }
    return true;
  }

  // Evaluate every alternative so exclusions win regardless of order:
  // any matching negated alternative rejects the type outright, otherwise
  // the type matches when at least one positive alternative matches.
  let positiveMatch = false;
  for (const alt of alternatives) {
    const pattern = alt.trim().toUpperCase();
    if (!pattern) continue;
    if (pattern.startsWith('!')) {
      // Exclusion within alternatives: treated as "not this one"
      const body = pattern.slice(1);
      if (
        upper === body ||
        (body.endsWith('*') && upper.startsWith(body.slice(0, -1)))
      ) {
        return false;
      }
      continue;
    }
    if (pattern.endsWith('*')) {
      if (upper.startsWith(pattern.slice(0, -1))) {
        positiveMatch = true;
      }
    } else if (upper === pattern) {
      positiveMatch = true;
    }
  }
  return positiveMatch;
}

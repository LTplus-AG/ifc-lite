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

  // Exclusion: !IfcWall means everything except IfcWall
  if (trimmed.startsWith('!')) {
    return !matchesSelector(typeName, trimmed.slice(1));
  }

  const alternatives = trimmed.split('|');
  const upper = typeName.toUpperCase();
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

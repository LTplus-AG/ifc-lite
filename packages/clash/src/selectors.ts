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
  for (const alt of alternatives) {
    const pattern = alt.trim().toUpperCase();
    if (!pattern) continue;
    if (pattern.startsWith('!')) {
      // Exclusion within alternatives: treated as "not this one"
      if (
        upper === pattern.slice(1) ||
        (pattern.slice(1).endsWith('*') && upper.startsWith(pattern.slice(1, -1)))
      ) {
        return false;
      }
      continue;
    }
    if (pattern.endsWith('*')) {
      if (upper.startsWith(pattern.slice(0, -1))) {
        return true;
      }
    } else if (upper === pattern) {
      return true;
    }
  }
  return false;
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Column-spec parser for `ifc-lite schedule`.
 *
 * A spec is a comma-separated list of `Header=path` pairs. `path` is either a
 * plain attribute name (`Name`, `Tag`, `GlobalId`), a `PsetName.PropName`, or a
 * `QtoName.QtyName`. A bare `path` with no `=` uses the path as its own header.
 */

import { fatal } from '../output.js';

export interface ScheduleColumn {
  header: string;
  path: string;
}

/**
 * Parse a `--columns` spec into an ordered list of `{ header, path }` columns.
 *
 * Paths are attribute names or dot-separated `Set.Member` references, neither of
 * which contains a comma, so splitting on the top-level comma is unambiguous.
 * Each segment is a `Header=path` pair; a segment with no `=` uses its whole
 * text as both header and path. Only the first `=` splits, so a value-side `=`
 * (unusual in a path but harmless) stays with the path.
 */
export function parseColumnSpec(spec: string | undefined): ScheduleColumn[] {
  if (spec === undefined || spec.trim() === '') {
    fatal('--columns is required, e.g. --columns "Name=Name, Level=Pset_WallCommon.Reference"');
  }

  const columns: ScheduleColumn[] = [];
  for (const rawSegment of spec.split(',')) {
    const segment = rawSegment.trim();
    if (segment === '') {
      fatal(`Invalid --columns spec: empty column in "${spec}". Expected "Header=path[, ...]".`);
    }

    const eqIdx = segment.indexOf('=');
    if (eqIdx === -1) {
      // Bare path: the path is its own header.
      columns.push({ header: segment, path: segment });
      continue;
    }

    const header = segment.slice(0, eqIdx).trim();
    const path = segment.slice(eqIdx + 1).trim();
    if (header === '' || path === '') {
      fatal(`Invalid --columns entry "${segment}": expected "Header=path" with both sides non-empty.`);
    }
    columns.push({ header, path });
  }

  if (columns.length === 0) {
    fatal(`Invalid --columns spec: "${spec}". Expected "Header=path[, ...]".`);
  }
  return columns;
}

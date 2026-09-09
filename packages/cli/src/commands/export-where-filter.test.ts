/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite export`'s `--where` flag parses through its own local
 * `parseWhereFilter` (a separate copy from `query.ts`'s -- see
 * `where-filter.ts`'s doc comment; the two must be kept in step by hand,
 * not by shared code), then feeds the parsed operator straight into
 * `bim.query().where(...)`, the same `ComparisonOp`-typed backend the CLI
 * `query` command and the MCP `query_entities` tool use. #4094 added
 * `matches` (regex) to that backend; this pins that `export --where`'s own
 * parser recognizes the `~=` token for it, the same way `query.ts`'s does.
 */

import { describe, expect, it } from 'vitest';
import { parseWhereFilter } from './export.js';

describe('export parseWhereFilter', () => {
  /**
   * Kills checking `~=` after `=` or `~` in the operator scan (or dropping
   * it from the scan list): either alone misparses "Prop~=oo" -- `=` alone
   * matches mid-token (propName "Prop~", operator '='), `~` alone leaves a
   * stray "=oo" in the value with operator 'contains'.
   */
  it('recognizes ~= as a single two-character regex operator, not = or ~ alone', () => {
    expect(parseWhereFilter('Pset.Prop~=^REI')).toEqual({
      psetName: 'Pset',
      propName: 'Prop',
      operator: 'matches',
      value: '^REI',
    });
  });

  it('still parses plain contains and the other operators unchanged', () => {
    expect(parseWhereFilter('Pset.Prop~oo')).toEqual({
      psetName: 'Pset',
      propName: 'Prop',
      operator: 'contains',
      value: 'oo',
    });
    expect(parseWhereFilter('Pset.Prop=5')).toEqual({
      psetName: 'Pset',
      propName: 'Prop',
      operator: '=',
      value: '5',
    });
  });
});

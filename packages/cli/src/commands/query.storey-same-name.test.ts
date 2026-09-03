/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `query --storey` resolved a name to a single storey via `Array.find`.
 * `IfcBuildingStorey.Name` is not unique — two storeys legally share a Name
 * as siblings under different buildings (or a malformed/federated file
 * duplicates a level name). `--storey "Level 1"` silently returned only the
 * FIRST matching storey's elements and dropped the second storey's elements
 * with no error and no warning — an "exit 0, wrong (incomplete) answer"
 * failure, the same shape as the same-named-sibling collapse already fixed
 * for the viewer's HierarchyPanel (#3545).
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryCommand } from './query.js';

const guid = (n: number): string => `SAME${String(n).padStart(19, '0')}`;

/**
 * Project -> Building -> two IfcBuildingStorey BOTH named "Level 1"
 * (a legal, if confusing, shape: e.g. two separate wings each starting
 * their own numbering). Storey #4 contains Wall A; storey #5 contains
 * Column C. Distinct TYPE keywords keep each element's storey membership
 * unambiguous in assertions.
 */
const FIXTURE_MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('same-named-storey-fixture.ifc','2024-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('${guid(1)}',$,'Project',$,$,$,$,$,$);
#3=IFCBUILDING('${guid(3)}',$,'Building',$,$,$,$,$,.ELEMENT.,$,$,$);
#4=IFCBUILDINGSTOREY('${guid(4)}',$,'Level 1',$,$,$,$,$,.ELEMENT.,0.);
#5=IFCBUILDINGSTOREY('${guid(5)}',$,'Level 1',$,$,$,$,$,.ELEMENT.,3.);
#10=IFCWALL('${guid(10)}',$,'Wall A',$,$,$,$,'TAG-A');
#17=IFCCOLUMN('${guid(17)}',$,'Column C',$,$,$,$,'TAG-C');
#30=IFCRELAGGREGATES('${guid(30)}',$,$,$,#1,(#3));
#31=IFCRELAGGREGATES('${guid(31)}',$,$,$,#3,(#4,#5));
#33=IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid(33)}',$,$,$,(#10),#4);
#34=IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid(34)}',$,$,$,(#17),#5);
ENDSEC;
END-ISO-10303-21;
`;

const FIXTURE_MODEL_UNIQUE = FIXTURE_MODEL.replace(
  `#5=IFCBUILDINGSTOREY('${guid(5)}',$,'Level 1',$,$,$,$,$,.ELEMENT.,3.);`,
  `#5=IFCBUILDINGSTOREY('${guid(5)}',$,'Level 2',$,$,$,$,$,.ELEMENT.,3.);`,
);

async function writeFixture(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ifc-lite-storey-samename-'));
  const path = join(dir, 'fixture.ifc');
  await writeFile(path, content, 'utf8');
  return path;
}

function captureStdout(): { out: string } {
  const state = { out: '' };
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
    state.out += chunk;
    return true;
  }) as typeof process.stdout.write);
  return state;
}

function names(jsonOut: string): string[] {
  const parsed = JSON.parse(jsonOut);
  return (Array.isArray(parsed) ? parsed : []).map((e: any) => e.name).sort();
}

describe('query --storey with two same-named storeys', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('includes elements from BOTH storeys named "Level 1", not just the first', async () => {
    const fixture = await writeFixture(FIXTURE_MODEL);
    const stdout = captureStdout();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await queryCommand([fixture, '--storey', 'Level 1', '--json']);

    expect(names(stdout.out)).toEqual(['Column C', 'Wall A']);
  });

  it('control: an unambiguous storey name still resolves correctly', async () => {
    const fixture = await writeFixture(FIXTURE_MODEL_UNIQUE);
    const stdout = captureStdout();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await queryCommand([fixture, '--storey', 'Level 1', '--json']);

    expect(names(stdout.out)).toEqual(['Wall A']);
  });

  it('a substring spanning two DIFFERENTLY named storeys errors instead of silently unioning them', async () => {
    // "Level" substring-matches both "Level 1" and "Level 2". Unioning them
    // would merge storeys the user never asked to combine, silently, with
    // exit 0 -- the same "wrong answer without an error" shape the exact-name
    // union exists to fix, inverted. First-match is no better: it picks one of
    // the two by array order. Ambiguity across different names must be loud.
    const fixture = await writeFixture(FIXTURE_MODEL_UNIQUE);
    captureStdout();
    const stderr = { out: '' };
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
      stderr.out += chunk;
      return true;
    }) as typeof process.stderr.write);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code}) called`);
    }) as never);

    await expect(queryCommand([fixture, '--storey', 'Level', '--json'])).rejects.toThrow(
      /process\.exit\(1\) called/,
    );
    expect(stderr.out).toMatch(/ambiguous/i);
    expect(stderr.out).toContain('Level 1');
    expect(stderr.out).toContain('Level 2');
  });

  it('a case-insensitive substring whose matches all share ONE Name still unions them', async () => {
    // "level 1" misses the (case-sensitive) exact tier but substring-matches
    // both storeys named "Level 1". That is the same-name family this fix
    // exists for, reached through the substring tier; there is no ambiguity
    // about WHICH storey is meant, only a duplicated Name.
    const fixture = await writeFixture(FIXTURE_MODEL);
    const stdout = captureStdout();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await queryCommand([fixture, '--storey', 'level 1', '--json']);

    expect(names(stdout.out)).toEqual(['Column C', 'Wall A']);
  });
});

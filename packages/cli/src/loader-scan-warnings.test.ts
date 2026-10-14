/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7610: the CLI loader logged the scan's "dropped a record" diagnostic at
 * debug level only, so every command, `mutate` and `export` included, answered
 * and wrote from a model missing records with nothing on stderr. A file with
 * two unescaped apostrophes (#7541) lost #20 and #30 silently.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseIfcBytes } from './loader.js';
import { mutateCommand } from './commands/mutate.js';

const gid = (n: number) => String(n).padStart(22, '0');
const file = (name20: string) => new TextEncoder().encode([
  'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION((''),'2;1');", "FILE_NAME('a','',(''),(''),'','','');",
  "FILE_SCHEMA(('IFC4'));", 'ENDSEC;', 'DATA;',
  `#1=IFCPROJECT('${gid(1)}',$,'P',$,$,$,$,$,#3);`, '#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);', '#3=IFCUNITASSIGNMENT((#2));',
  `#20=IFCWALL('${gid(20)}',$,${name20},$,$,$,$,$,$);`, `#21=IFCWALL('${gid(21)}',$,'W2',$,$,$,$,$,$);`,
  'ENDSEC;', 'END-ISO-10303-21;', '',
].join('\n'));

function stderrDuring(): { lines: string[] } {
  const out = { lines: [] as string[] };
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    out.lines.push(String(chunk));
    return true;
  });
  return out;
}

afterEach(() => vi.restoreAllMocks());

describe('the CLI says when the scan dropped records (#7610)', () => {
  it('warns on stderr, by default, when the scan refuses a record', async () => {
    const err = stderrDuring();
    const store = await parseIfcBytes(file("'it's'"), 'stray.ifc');
    expect(store.entityIndex.byId.has(20)).toBe(false);
    expect(store.entityIndex.byId.has(21)).toBe(true);
    const warned = err.lines.filter((l) => l.includes("stray.ifc: scan: dropped a record with no terminating ';'"));
    expect(warned).toHaveLength(1);
  });

  it('says nothing for a file read in full', async () => {
    const err = stderrDuring();
    const store = await parseIfcBytes(file("'it''s'"), 'ok.ifc');
    expect(store.entityIndex.byId.has(20)).toBe(true);
    expect(err.lines.filter((l) => l.includes('scan:'))).toEqual([]);
  });

  // The real command, end to end: before #7610 it printed only
  // "Entity #20 not found" for a record the scan had refused.
  async function mutateRun(name20: string, id: number): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'mutate-7610-'));
    const path = join(dir, 'in.ifc');
    writeFileSync(path, file(name20));
    const err = stderrDuring();
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as typeof process.exit);
    await expect(mutateCommand([path, '--id', String(id), '--set', 'Name=X', '--out', join(dir, 'out.ifc')]))
      .rejects.toThrow('exit 1');
    return err.lines.join('');
  }

  it('mutate names the dropped records as the likely cause of a missing id', async () => {
    const out = await mutateRun("'it's'", 20);
    expect(out).toContain('Entity #20 not found. The scan dropped or skipped records');
    expect(out).toContain('#20 may be one of them');
  });

  it('mutate keeps the plain message when the scan read every record', async () => {
    const out = await mutateRun("'it''s'", 99);
    expect(out).toContain('Error: Entity #99 not found\n');
    expect(out).not.toContain('may be one of them');
  });
});

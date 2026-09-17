/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `eval --type` prints one `<label>: <value>` line per entity. An entity whose
 * Name is an explicit empty IfcLabel ('') must be labelled like one with no
 * Name at all, by its GlobalId, instead of printing a bare `: <value>` (#4881).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evalCommand } from './eval.js';

const IFC = [
  'ISO-10303-21;',
  'HEADER;',
  "FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');",
  "FILE_NAME('label.ifc','2026-01-01T00:00:00',('Author'),('Org'),'Exporter','eval label','');",
  "FILE_SCHEMA(('IFC4'));",
  'ENDSEC;',
  'DATA;',
  "#1=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'Project',$,$,$,$,$,$);",
  "#10=IFCWALL('2O2Fr$t4X7Zf8NOew3FLOH',$,'',$,$,$,$,$,$);",
  "#11=IFCWALL('3nYxLp6dP9FhWqDqbJ4Yk1',$,'Named wall',$,$,$,$,$,$);",
  'ENDSEC;',
  'END-ISO-10303-21;',
  '',
].join('\n');

describe('eval --type labels (#4881)', () => {
  let dir: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("labels an entity with Name '' by its GlobalId, and a named one by its Name", async () => {
    dir = await mkdtemp(join(tmpdir(), 'ifc-lite-eval-label-'));
    const file = join(dir, 'label.ifc');
    await writeFile(file, IFC);
    let out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
      out += chunk;
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await evalCommand([file, '1', '--type', 'IfcWall']);

    const lines = out.trim().split('\n').sort();
    expect(lines).toEqual(['2O2Fr$t4X7Zf8NOew3FLOH: 1', 'Named wall: 1']);
  });
});

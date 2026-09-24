/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `--type` means the same thing across this CLI: the named class AND its
 * subtypes. `query`, `export`, `anonymize` and `mutate` all expand; only
 * `extract-entities` compared `inst.type === t.toUpperCase()` exactly, so
 * `--type IfcWall` selected nothing on a model whose walls are all
 * `IfcWallStandardCase` -- which is the verbatim example in
 * `docs/guide/cli.md` (#5530).
 *
 * The model here is written inline rather than fetched: the defect only needs
 * one entity whose class is a SUBTYPE of the requested one, and a fixture that
 * has to be downloaded would let this suite skip on a machine that never ran
 * `pnpm fixtures`, which is how the defect survived in the first place.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractEntitiesCommand } from './extract-entities.js';

/**
 * Two walls: one `IFCWALL`, one `IFCWALLSTANDARDCASE`. Minimal but real STEP --
 * the command runs its own tokenizer over this text.
 */
const MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','2026-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0000000000000000000001',$,'P',$,$,$,$,$,$);
#2=IFCWALL('0000000000000000000002',$,'Plain wall',$,$,$,$,$,$);
#3=IFCWALLSTANDARDCASE('0000000000000000000003',$,'Standard wall',$,$,$,$,$,$);
#4=IFCDOOR('0000000000000000000004',$,'A door',$,$,$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
`;

afterEach(() => {
  vi.restoreAllMocks();
});

/** Run the command in a throwaway directory; report which ids reached the output. */
async function extractedIds(args: string[]): Promise<number[]> {
  const dir = mkdtempSync(join(tmpdir(), 'ifc-lite-extract-'));
  try {
    const modelPath = join(dir, 'model.ifc');
    const outPath = join(dir, 'out.ifc');
    writeFileSync(modelPath, MODEL);
    await extractEntitiesCommand([modelPath, ...args, '--out', outPath]);
    const out = readFileSync(outPath, 'utf-8');
    return [2, 3, 4].filter((id) => out.includes(`#${id}=`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Run the command expecting it to fail; return what it wrote to stderr. */
async function failureOutput(args: string[]): Promise<string> {
  const stderr: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  });
  await expect(extractedIds(args)).rejects.toThrow();
  return stderr.join('');
}

describe('extract-entities --type expands subtypes', () => {
  it('selects IfcWallStandardCase for --type IfcWall', async () => {
    const ids = await extractedIds(['--type', 'IfcWall']);
    // Both walls, and not the door.
    expect(ids).toEqual([2, 3]);
  });

  it('still selects only the exact class when the exact class is named', async () => {
    const ids = await extractedIds(['--type', 'IfcWallStandardCase']);
    expect(ids).toEqual([3]);
  });

  it('accepts several comma-separated types', async () => {
    const ids = await extractedIds(['--type', 'IfcWall,IfcDoor']);
    expect(ids).toEqual([2, 3, 4]);
  });
});

describe('an empty selection names the selector that came back empty', () => {
  it('reports the --type that matched nothing, not the list of flags', async () => {
    expect(await failureOutput(['--type', 'IfcTank'])).toMatch(/--type IfcTank/);
  });
});

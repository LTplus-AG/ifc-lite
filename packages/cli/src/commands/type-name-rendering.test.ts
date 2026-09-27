/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * AGENTS.md, "IFC schema fidelity": user-facing output uses the exact IFC
 * EXPRESS name. STEP stores class names UPPERCASE, and `entityIndex.byType` is
 * keyed by that raw spelling, so anything rendering a key straight out of it
 * prints `IFCWALLSTANDARDCASE` where `IfcWallStandardCase` belongs.
 *
 * `info` half-did it: `typeCounts` mapped through `IFC_ENTITY_NAMES`, the drop
 * census did not, so one report showed the SAME class both ways. `gym`'s
 * observation -- the machine-readable contract an agent consumes -- was raw
 * throughout, and so disagreed with `info --json` on the same model (#5533).
 *
 * The model is inline: the defect needs one entity of a known class and one of
 * a class the schema table does not know, and a fixture that has to be
 * downloaded would let this skip on a machine that never ran `pnpm fixtures`.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','2026-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0000000000000000000001',$,'P',$,$,$,$,$,$);
#2=IFCWALLSTANDARDCASE('0000000000000000000002',$,'W',$,$,$,$,$,$);
#3=IFCCARTESIANPOINT((0.,0.,0.));
ENDSEC;
END-ISO-10303-21;
`;

/** Anything that looks like a raw STEP class name: IFC + all caps. */
const RAW_STEP_CLASS = /\bIFC[A-Z0-9_]{3,}\b/;

afterEach(() => {
  vi.restoreAllMocks();
});

function withModel<T>(run: (modelPath: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'ifc-lite-typenames-'));
  const modelPath = join(dir, 'model.ifc');
  writeFileSync(modelPath, MODEL);
  return run(modelPath).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** Everything the command wrote to stdout. */
async function stdoutOf(run: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  await run();
  return chunks.join('');
}

describe('info renders canonical IFC EXPRESS names', () => {
  it('uses one spelling for a class across every section of --json', async () => {
    const out = await withModel(async (modelPath) => {
      const { infoCommand } = await import('./info.js');
      return stdoutOf(() => infoCommand([modelPath, '--json']));
    });

    expect(out).toContain('IfcWallStandardCase');
    const offender = RAW_STEP_CLASS.exec(out);
    expect(offender?.[0], `info --json printed a raw STEP class name`).toBeUndefined();
  });

  it('uses canonical names in the human report too', async () => {
    const out = await withModel(async (modelPath) => {
      const { infoCommand } = await import('./info.js');
      return stdoutOf(() => infoCommand([modelPath]));
    });

    const offender = RAW_STEP_CLASS.exec(out);
    expect(offender?.[0], `info printed a raw STEP class name`).toBeUndefined();
  });
});

describe('the gym observation agrees with info', () => {
  it('reports entity counts under canonical names', async () => {
    const lines = await withModel(async (modelPath) => {
      const { gymCommand } = await import('./gym.js');
      const { PassThrough, Readable } = await import('node:stream');
      const emitted: string[] = [];
      const output = new PassThrough();
      output.on('data', (chunk: Buffer) => emitted.push(chunk.toString()));
      await gymCommand(['--model', modelPath, '--checks', 'schema'], {
        output: output as unknown as NodeJS.WritableStream,
        input: Readable.from(['{"type":"close"}\n']) as unknown as NodeJS.ReadableStream,
      });
      return emitted.join('');
    });

    const reset = lines
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; observation?: { entityCounts?: Record<string, number> } })
      .find((message) => message.type === 'reset');

    const counts = reset?.observation?.entityCounts ?? {};
    expect(Object.keys(counts)).toContain('IfcWallStandardCase');
    const offender = Object.keys(counts).find((name) => RAW_STEP_CLASS.test(name));
    expect(offender, `gym reported a raw STEP class name`).toBeUndefined();
  });
});

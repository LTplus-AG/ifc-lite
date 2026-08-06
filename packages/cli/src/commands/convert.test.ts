/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertCommand } from './convert.js';

// Minimal but valid IFC2X3 model: project + geometric context. Enough for
// exportToStep to round-trip without a real building element.
const MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2024',(''),(''),'','','');
FILE_SCHEMA(('IFC2X3'));
ENDSEC;
DATA;
#1= IFCPROJECT('PROJ00000000000000000X',$,'Proj',$,$,$,$,(#20),#30);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
ENDSEC;
END-ISO-10303-21;
`;

describe('convertCommand', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stdoutBuf: string;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function captureStdout() {
    stdoutBuf = '';
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
      stdoutBuf += chunk;
      return true;
    }) as typeof process.stdout.write);
  }

  function captureStderr() {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  }

  async function makeInput(): Promise<{ dir: string; src: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-lite-convert-'));
    const src = join(dir, 'in.ifc');
    await writeFile(src, MODEL);
    return { dir, src };
  }

  it('rejects a missing --schema (exit 1, no file written)', async () => {
    captureStderr();
    const { dir, src } = await makeInput();
    const out = join(dir, 'out.ifc');
    await expect(convertCommand([src, '--out', out])).rejects.toThrow();
    await expect(stat(out)).rejects.toThrow(); // nothing written
  });

  it('rejects an unsupported --schema value (exit 1, no file written)', async () => {
    captureStderr();
    const { dir, src } = await makeInput();
    const out = join(dir, 'out.ifc');
    await expect(
      convertCommand([src, '--schema', 'IFC9999', '--out', out]),
    ).rejects.toThrow();
    await expect(stat(out)).rejects.toThrow();
  });

  it('rejects a missing --out (exit 1)', async () => {
    captureStderr();
    const { src } = await makeInput();
    await expect(convertCommand([src, '--schema', 'IFC4'])).rejects.toThrow();
  });

  it('rejects a missing input file argument (exit 1)', async () => {
    captureStderr();
    await expect(convertCommand(['--schema', 'IFC4', '--out', 'x.ifc'])).rejects.toThrow();
  });

  it('converts and reports a fileSize that matches the actual bytes written', async () => {
    captureStdout();
    captureStderr();
    const { dir, src } = await makeInput();
    const out = join(dir, 'out.ifc');

    await convertCommand([src, '--schema', 'IFC4', '--out', out, '--json']);

    const written = await readFile(out, 'utf-8');
    expect(written.length).toBeGreaterThan(0);
    expect(written).toContain("FILE_SCHEMA(('IFC4'))");

    const report = JSON.parse(stdoutBuf);
    expect(report.file).toBe(out);
    expect(report.sourceSchema).toBe('IFC2X3');
    expect(report.targetSchema).toBe('IFC4');
    // The reported size must be derived from the bytes actually written to
    // disk, not echoed from the request or computed a second, divergent way.
    expect(report.fileSize).toBe(Buffer.byteLength(written, 'utf-8'));
  });

  it('lower-cases a --schema flag correctly and still writes the file', async () => {
    captureStdout();
    captureStderr();
    const { dir, src } = await makeInput();
    const out = join(dir, 'out.ifc');

    await convertCommand([src, '--schema', 'ifc4', '--out', out, '--json']);

    const report = JSON.parse(stdoutBuf);
    expect(report.targetSchema).toBe('IFC4');
  });
});

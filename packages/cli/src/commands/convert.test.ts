/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertCommand } from './convert.js';

// Minimal but valid IFC2X3 model: project + geometric context + a real
// OwnerHistory chain. IfcRoot.OwnerHistory is OPTIONAL in IFC4 but
// MANDATORY in IFC2X3 -- a `$` there makes the fixture schema-invalid for
// the schema it claims to be, which defeats the point of round-tripping a
// real IFC2X3 file through the converter.
const MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2024',(''),(''),'','','');
FILE_SCHEMA(('IFC2X3'));
ENDSEC;
DATA;
#1= IFCPROJECT('PROJ00000000000000000X',#45,'Proj',$,$,$,$,(#20),#30);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40= IFCPERSON($,$,'Tester',$,$,$,$,$);
#41= IFCORGANIZATION($,'Org',$,$,$);
#42= IFCPERSONANDORGANIZATION(#40,#41,$);
#43= IFCORGANIZATION($,'AppDev',$,$,$);
#44= IFCAPPLICATION(#43,'1.0','App','app-id');
#45= IFCOWNERHISTORY(#42,#44,$,.ADDED.,$,$,$,0);
ENDSEC;
END-ISO-10303-21;
`;

describe('convertCommand', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stdoutBuf: string;
  let stderrBuf: string;
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
  });

  function captureStdout() {
    stdoutBuf = '';
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
      stdoutBuf += chunk;
      return true;
    }) as typeof process.stdout.write);
  }

  function captureStderr() {
    stderrBuf = '';
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
      stderrBuf += chunk;
      return true;
    }) as typeof process.stderr.write);
  }

  async function makeInput(): Promise<{ dir: string; src: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-lite-convert-'));
    tempDirs.push(dir);
    const src = join(dir, 'in.ifc');
    await writeFile(src, MODEL);
    return { dir, src };
  }

  it('rejects a missing --schema (exit 1, no file written)', async () => {
    captureStderr();
    const { dir, src } = await makeInput();
    const out = join(dir, 'out.ifc');
    await expect(convertCommand([src, '--out', out])).rejects.toThrow();
    // Assert the failure is actually the missing---schema guard, not some
    // other exit(1) (e.g. a load failure) that `rejects.toThrow()` alone
    // cannot distinguish.
    expect(stderrBuf).toContain('--schema is required');
    await expect(stat(out)).rejects.toThrow(); // nothing written
  });

  it('rejects an unsupported --schema value (exit 1, no file written)', async () => {
    captureStderr();
    const { dir, src } = await makeInput();
    const out = join(dir, 'out.ifc');
    await expect(
      convertCommand([src, '--schema', 'IFC9999', '--out', out]),
    ).rejects.toThrow();
    expect(stderrBuf).toContain('Invalid schema: IFC9999');
    await expect(stat(out)).rejects.toThrow();
  });

  it('rejects a missing --out (exit 1)', async () => {
    captureStderr();
    const { src } = await makeInput();
    await expect(convertCommand([src, '--schema', 'IFC4'])).rejects.toThrow();
    expect(stderrBuf).toContain('--out is required');
  });

  it('rejects a missing input file argument (exit 1)', async () => {
    captureStderr();
    // Any non-dash token -- including a flag's own value -- satisfies
    // `args.find(a => !a.startsWith('-'))`'s positional-filePath detection.
    // `['--schema', 'IFC4', ...]` would silently treat "IFC4" as the file
    // path instead of exercising the missing-file guard, so this case is
    // the one genuinely-empty-of-positionals invocation: no args at all.
    await expect(convertCommand([])).rejects.toThrow();
    expect(stderrBuf).toContain('Usage: ifc-lite convert');
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
    // The report alone doesn't prove the file on disk was actually written
    // with the upper-cased schema -- read it back.
    const written = await readFile(out, 'utf-8');
    expect(written).toContain("FILE_SCHEMA(('IFC4'))");
  });

  // #4206: an entity type with no representation in the target schema, and
  // no IfcRoot ancestor, cannot be dropped or proxied — `exportToStep` throws
  // from inside `convertStepLine` rather than write a corrupt file. Before
  // this fix, `convertCommand` let that exception surface raw (a stack trace,
  // no indication of WHICH entity or that others share the problem). It
  // should now refuse cleanly, before writing anything, naming the entity.
  it('refuses an unrepresentable-and-unrooted target type before writing any file (structural load configuration → IFC2X3)', async () => {
    captureStderr();
    const { dir } = await makeInput();
    const withLoadConfig = MODEL.replace(
      'ENDSEC;\nEND-ISO-10303-21;',
      "#326= IFCSTRUCTURALLOADCONFIGURATION($,(#327),((96.)));\n" +
      "#327= IFCSTRUCTURALLOADSINGLEFORCE('F',1.,0.,0.,0.,0.,0.);\n" +
      'ENDSEC;\nEND-ISO-10303-21;',
    );
    const out = join(dir, 'out.ifc');

    // IfcStructuralLoadConfiguration is an IFC4-only type, so the source
    // must declare an IFC4 header (MODEL's own FILE_SCHEMA claims IFC2X3).
    const ifc4Src = join(dir, 'in-ifc4.ifc');
    await writeFile(
      ifc4Src,
      withLoadConfig.replace("FILE_SCHEMA(('IFC2X3'));", "FILE_SCHEMA(('IFC4'));"),
    );

    await expect(convertCommand([ifc4Src, '--schema', 'IFC2X3', '--out', out])).rejects.toThrow();
    expect(stderrBuf).toContain('IFCSTRUCTURALLOADCONFIGURATION');
    expect(stderrBuf).toContain('#326');
    expect(stderrBuf).toContain('Cannot convert');
    await expect(stat(out)).rejects.toThrow(); // nothing written
  });

  it('reports a lossy structural rename in the --json output without blocking the export', async () => {
    captureStdout();
    captureStderr();
    const { dir, src } = await makeInput();
    const withLoadCase = MODEL.replace(
      'ENDSEC;\nEND-ISO-10303-21;',
      "#312= IFCSTRUCTURALLOADCASE('2fv4DZfY55exwX8QDy8dmw',#45,'Case',$,$,.LOAD_CASE.,.NOTDEFINED.,.NOTDEFINED.,1.,$,(0.,0.,0.));\n" +
      'ENDSEC;\nEND-ISO-10303-21;',
    ).replace("FILE_SCHEMA(('IFC2X3'));", "FILE_SCHEMA(('IFC4'));");
    await writeFile(src, withLoadCase);
    const out = join(dir, 'out.ifc');

    await convertCommand([src, '--schema', 'IFC2X3', '--out', out, '--json']);

    expect(stderrBuf).toContain('IFCSTRUCTURALLOADCASE');
    expect(stderrBuf).toContain('SelfWeightCoefficients');
    const report = JSON.parse(stdoutBuf);
    const entry = report.lossReport.find((e: { type: string }) => e.type === 'IFCSTRUCTURALLOADCASE');
    expect(entry).toMatchObject({
      targetType: 'IFCSTRUCTURALLOADGROUP',
      kind: 'lossy',
      count: 1,
      droppedAttributes: ['SelfWeightCoefficients'],
    });
    const written = await readFile(out, 'utf-8');
    expect(written).toContain('IFCSTRUCTURALLOADGROUP');
  });
});

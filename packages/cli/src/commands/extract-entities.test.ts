/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeometryProcessor } from '@ifc-lite/geometry';
import { scoreTriage, extractEntitiesCommand } from './extract-entities.js';

// The subset engine itself (parseStep, buildSubset, ...) is tested next to it in
// packages/export/src/step-subset.test.ts. These cases drive the command.

const __dirname = dirname(fileURLToPath(import.meta.url));
// Committed viewer demo sample with real render geometry, needed for the
// `--detect` triage path (it meshes the model via GeometryProcessor).
const SAMPLE_IFC = join(__dirname, '../../../../apps/viewer/public/samples/hello-wall.ifc');

// #4148: a Name literal naming a REAL id in the model is not a reference.
const LOOKALIKE_MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2024',(''),(''),'','','');
FILE_SCHEMA(('IFC2X3'));
ENDSEC;
DATA;
#70= IFCFURNISHINGELEMENT('CHAIR000000000000000X',$,'Chair pairs with #71',$,$,#50,$,'tag');
#50= IFCLOCALPLACEMENT($,$);
#71= IFCFURNISHINGELEMENT('CHAIR100000000000000X',$,'Other chair',$,$,#51,$,'tag2');
#51= IFCLOCALPLACEMENT($,$);
ENDSEC;
END-ISO-10303-21;
`;

describe('extract-entities --product: string text is not a reference (#4148)', () => {
  // CLI-level counterpart of the unit test above: `forwardClosure` is an
  // internal helper `--product` runs through (see `extractEntitiesCommand`),
  // so a regression there could pass the helper-level test above while the
  // command itself still emits the wrong bytes. Exercise the actual command
  // and assert on its output file, not just the in-memory `keep` set.
  it('extracting --product #70 does not emit the lookalike id pulled in only by string text', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-extract-lookalike-'));
    const src = join(dir, 'in.ifc');
    const out = join(dir, 'sub.ifc');
    await writeFile(src, LOOKALIKE_MODEL, 'latin1');
    await extractEntitiesCommand([src, '--product', '#70', '--out', out]);
    const text = await readFile(out, 'latin1');
    expect(text).toContain('#70=');
    expect(text).toContain('#50=');
    // #71 and its own placement #51 are only mentioned inside #70's Name
    // TEXT, never referenced as an attribute — they must not be emitted.
    expect(text).not.toContain('#71=');
    expect(text).not.toContain('#51=');
  });
});

const VOID_MODEL = `ISO-10303-21;
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
#40= IFCLOCALPLACEMENT($,#21);
#41= IFCBUILDINGSTOREY('STOR00000000000000000X',$,'L01',$,$,#40,$,$,.ELEMENT.,0.);
#50= IFCLOCALPLACEMENT(#40,#21);
#60= IFCRECTANGLEPROFILEDEF(.AREA.,$,#21,2.,0.2);
#61= IFCEXTRUDEDAREASOLID(#60,#21,#62,3.);
#62= IFCDIRECTION((0.,0.,1.));
#63= IFCSHAPEREPRESENTATION(#20,'Body','SweptSolid',(#61));
#64= IFCPRODUCTDEFINITIONSHAPE($,$,(#63));
#70= IFCWALLSTANDARDCASE('WALL00000000000000000X',$,'Wall',$,$,#50,#64,'tag');
#100= IFCEXTRUDEDAREASOLID(#60,#21,#62,3.);
#101= IFCSHAPEREPRESENTATION(#20,'Body','SweptSolid',(#100));
#102= IFCPRODUCTDEFINITIONSHAPE($,$,(#101));
#103= IFCOPENINGELEMENT('OPEN00000000000000000X',$,'Opening',$,$,#50,#102,'op');
#104= IFCRELVOIDSELEMENT('VOID00000000000000000X',$,$,$,#70,#103);
#110= IFCSHAPEREPRESENTATION(#20,'Body','SweptSolid',(#100));
#111= IFCPRODUCTDEFINITIONSHAPE($,$,(#110));
#112= IFCWINDOW('WIN000000000000000000X',$,'Window',$,$,#50,#111,'w',1.,1.);
#113= IFCRELFILLSELEMENT('FILL00000000000000000X',$,$,$,#103,#112);
ENDSEC;
END-ISO-10303-21;
`;

// L01's storey record carries a Description that is free TEXT naming L02's
// REAL IfcLocalPlacement (`'dup of #44'`), and L01's own furniture Name
// mentions L02's placement id too (`'see also #44'`). Neither is a reference;
// both are `#id`-shaped substrings a raw `/#(\d+)/g` scan cannot tell apart
// from one. #4166.
const TWO_STOREY_MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2024',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('PROJ000000000000000002',#5,'Proj',$,$,$,$,(#20),#30);
#5= IFCOWNERHISTORY($,$,$,.NOCHANGE.,$,$,$,0);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#33= IFCLOCALPLACEMENT($,#21);
#34= IFCSITE('SITE000000000000000002',#5,'Site',$,$,#33,$,$,.ELEMENT.,$,$,$,$,$);
#35= IFCLOCALPLACEMENT(#33,#21);
#36= IFCBUILDING('BLDG000000000000000002',#5,'Bldg',$,$,#35,$,$,.ELEMENT.,$,$,$);
#40= IFCLOCALPLACEMENT(#35,#21);
#41= IFCBUILDINGSTOREY('STOR000000000000000003',#5,'L01','dup of #44',$,#40,$,$,.ELEMENT.,0.);
#44= IFCLOCALPLACEMENT(#35,#21);
#45= IFCBUILDINGSTOREY('STOR000000000000000004',#5,'L02',$,$,#44,$,$,.ELEMENT.,3.);
#50= IFCLOCALPLACEMENT(#40,#21);
#54= IFCLOCALPLACEMENT(#44,#21);
#60= IFCRECTANGLEPROFILEDEF(.AREA.,$,#21,2.,0.2);
#61= IFCEXTRUDEDAREASOLID(#60,#21,#62,3.);
#62= IFCDIRECTION((0.,0.,1.));
#63= IFCSHAPEREPRESENTATION(#20,'Body','SweptSolid',(#61));
#64= IFCPRODUCTDEFINITIONSHAPE($,$,(#63));
#70= IFCWALLSTANDARDCASE('WALL000000000000000001',#5,'Wall L01',$,$,#50,#64,'w1');
#90= IFCWALLSTANDARDCASE('WALL000000000000000002',#5,'Wall L02',$,$,#54,#64,'w2');
#95= IFCFURNISHINGELEMENT('FURN000000000000000007',#5,'see also #44',$,$,#50,#64,'f1');
ENDSEC;
END-ISO-10303-21;
`;

describe('extract-entities --storey: a free-text `#id` naming a real unrelated entity (#4166)', () => {
  it('picks the storey genuine placement, not the id its Description text names', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-extract-storey-'));
    const src = join(dir, 'in.ifc');
    const out = join(dir, 'sub.ifc');
    await writeFile(src, TWO_STOREY_MODEL, 'latin1');
    await extractEntitiesCommand([src, '--storey', 'L01', '--out', out]);
    const text = await readFile(out, 'latin1');
    // The genuine L01 wall is present …
    expect(text).toContain('#70=');
    // … the impostor pulled in only because #44 sits in L01's Description text
    // (a real placement, but L02's) must not be.
    expect(text).not.toContain('#90=');
  });

  it('does not seed a product into a storey extraction because its Name mentions that storey placement id', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-extract-storey-'));
    const src = join(dir, 'in.ifc');
    const out = join(dir, 'sub.ifc');
    await writeFile(src, TWO_STOREY_MODEL, 'latin1');
    // #95 is genuinely placed under L01 (#50 chains to #40), and its Name text
    // mentions L02's placement id #44. Extracting L02 must not pull it in.
    await extractEntitiesCommand([src, '--storey', 'L02', '--out', out]);
    const text = await readFile(out, 'latin1');
    expect(text).toContain('#90=');
    expect(text).not.toContain('#95=');
  });

  it('a storey/product with no string-borne ids extracts exactly as before (regression guard)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-extract-storey-'));
    const src = join(dir, 'in.ifc');
    const out = join(dir, 'sub.ifc');
    // Same shape, no poison text in Description/Name.
    const clean = TWO_STOREY_MODEL.replace("'dup of #44'", '$').replace("'see also #44'", "'Chair'");
    await writeFile(src, clean, 'latin1');
    await extractEntitiesCommand([src, '--storey', 'L01', '--out', out]);
    const text = await readFile(out, 'latin1');
    // #70 and #95 are both genuinely placed under L01 and belong in the
    // extraction; #90 is genuinely under L02 and does not.
    expect(text).toContain('#70=');
    expect(text).toContain('#95=');
    expect(text).not.toContain('#90=');
  });
});

describe('extract-entities byte fidelity', () => {
  it('round-trips raw Latin-1 high bytes unchanged (no U+FFFD mangling)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-extract-'));
    const src = join(dir, 'in.ifc');
    const out = join(dir, 'sub.ifc');
    // 0xFC ('ü' in Latin-1) is an invalid standalone UTF-8 byte; real-world
    // exports carry such raw bytes and must survive extraction untouched.
    await writeFile(src, Buffer.from(VOID_MODEL.replace("'Wall'", "'Türwand'"), 'latin1'));
    await extractEntitiesCommand([src, '--product', '#70', '--out', out]);
    const bytes = await readFile(out);
    expect(bytes.includes(Buffer.from([0xfc]))).toBe(true);
    expect(bytes.includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(false); // U+FFFD
  });
});

describe('scoreTriage', () => {
  it('always ranks a hard defect (non-finite, then huge) above any AABB heuristic', () => {
    const nan = scoreTriage({ expressId: 1, ifcType: 'IfcWall', tris: 2, nonFinite: 1, huge: 0, aabbBlowout: 1 });
    const huge = scoreTriage({ expressId: 2, ifcType: 'IfcWall', tris: 2, nonFinite: 0, huge: 5, aabbBlowout: 999 });
    const heuristic = scoreTriage({ expressId: 3, ifcType: 'IfcSlab', tris: 2, nonFinite: 0, huge: 0, aabbBlowout: 50 });
    expect(nan).toBeGreaterThan(huge);
    expect(huge).toBeGreaterThan(heuristic);
  });
});

describe('triage (--detect) WASM disposal (#1959 P2 leak)', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    stdoutSpy?.mockRestore();
    vi.restoreAllMocks();
  });

  it('disposes the GeometryProcessor WASM handle on the success path', async () => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const disposeSpy = vi.spyOn(GeometryProcessor.prototype, 'dispose');

    await extractEntitiesCommand([SAMPLE_IFC, '--detect', '--report', '--json']);

    expect(disposeSpy).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('disposes the GeometryProcessor WASM handle when meshing throws', async () => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const disposeSpy = vi.spyOn(GeometryProcessor.prototype, 'dispose');
    vi.spyOn(GeometryProcessor.prototype, 'process').mockRejectedValue(new Error('forced meshing failure'));

    await expect(
      extractEntitiesCommand([SAMPLE_IFC, '--detect', '--report', '--json']),
    ).rejects.toThrow('forced meshing failure');

    expect(disposeSpy).toHaveBeenCalledTimes(1);
  }, 30_000);
});

describe('extract-entities --detect --report --json: --top', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    stdoutSpy?.mockRestore();
    vi.restoreAllMocks();
  });

  /** Runs the triage JSON path and returns the parsed `top` array. */
  async function runTriage(extraArgs: string[]): Promise<unknown[]> {
    const writes: string[] = [];
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    await extractEntitiesCommand([SAMPLE_IFC, '--detect', '--report', '--json', ...extraArgs]);
    const parsed = JSON.parse(writes.join(''));
    return parsed.top;
  }

  it('falls back to the default 20-row --top on a non-numeric value, not an empty array', async () => {
    const processGeometry = GeometryProcessor.prototype.process;
    vi.spyOn(GeometryProcessor.prototype, 'process').mockImplementation(async function (
      this: GeometryProcessor,
      ...args
    ) {
      const result = await processGeometry.apply(this, args);
      const seed = result.meshes[0];
      if (seed === undefined) throw new Error('fixture must produce at least one mesh');
      return {
        ...result,
        meshes: Array.from({ length: 25 }, (_, index) => ({
          ...seed,
          expressId: index + 1,
        })),
      };
    });
    const withBadTop = await runTriage(['--top', 'banana']);

    // Pin the documented default itself. Deriving this expectation from an
    // omitted --top invocation would let both paths regress to the same value.
    expect(withBadTop).toHaveLength(20);
    expect(withBadTop.map((row) => (row as { expressId: number }).expressId)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
      11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    ]);
  }, 30_000);

  it('still honors an ordinary numeric --top', async () => {
    const baseline = await runTriage([]);
    stdoutSpy.mockRestore();
    const withTopOne = await runTriage(['--top', '1']);

    expect(baseline.length).toBeGreaterThan(1);
    expect(withTopOne).toEqual(baseline.slice(0, 1));
  }, 30_000);
});

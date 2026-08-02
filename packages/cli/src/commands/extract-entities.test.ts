/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseStep,
  resolveToId,
  forwardClosure,
  buildSubset,
  serializeSubset,
  scoreTriage,
  extractEntitiesCommand,
} from './extract-entities.js';

// A tiny but representative model: project + units + geometric context + a
// storey, one wall placed under the storey (with a placement chain and a
// rectangle-extrusion body), a containment relation, and — critically — a Name
// literal carrying both `;` and `#` to exercise the string-aware tokenizer.
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
#40= IFCLOCALPLACEMENT($,#21);
#41= IFCBUILDINGSTOREY('STOR00000000000000000X',$,'L01',$,$,#40,$,$,.ELEMENT.,0.);
#50= IFCLOCALPLACEMENT(#40,#21);
#60= IFCRECTANGLEPROFILEDEF(.AREA.,$,#21,2.,0.2);
#61= IFCEXTRUDEDAREASOLID(#60,#21,#62,3.);
#62= IFCDIRECTION((0.,0.,1.));
#63= IFCSHAPEREPRESENTATION(#20,'Body','SweptSolid',(#61));
#64= IFCPRODUCTDEFINITIONSHAPE($,$,(#63));
#70= IFCWALLSTANDARDCASE('WALL00000000000000000X',$,'Basic Wall:type;01 #north',$,$,#50,#64,'tag');
#80= IFCRELCONTAINEDINSPATIALSTRUCTURE('REL000000000000000000X',$,$,$,(#70),#41);
#90= IFCWALLSTANDARDCASE('WALO00000000000000000X',$,'Other',$,$,#40,#64,'tag2');
#91= IFCRELCONTAINEDINSPATIALSTRUCTURE('RELO00000000000000000X',$,$,$,(#70,#90),#41);
ENDSEC;
END-ISO-10303-21;
`;

describe('parseStep', () => {
  it('tokenizes instances despite ; and # inside a string literal', () => {
    const p = parseStep(MODEL);
    const wall = p.instances.get(70);
    expect(wall?.type).toBe('IFCWALLSTANDARDCASE');
    // The Name "Basic Wall:type;01 #north" must NOT split the instance.
    expect(wall?.full).toContain("'Basic Wall:type;01 #north'");
    // 18 data instances parsed; the `#north` inside the Name string must NOT be
    // mistaken for a 19th instance definition.
    expect(p.instances.size).toBe(18);
  });

  it('indexes GlobalIds of rooted entities', () => {
    const p = parseStep(MODEL);
    expect(p.guidToId.get('WALL00000000000000000X')).toBe(70);
    expect(p.guidToId.get('PROJ00000000000000000X')).toBe(1);
  });
});

describe('resolveToId', () => {
  const p = parseStep(MODEL);
  it('resolves #id, bare id, and GlobalId', () => {
    expect(resolveToId('#70', p)).toBe(70);
    expect(resolveToId('70', p)).toBe(70);
    expect(resolveToId('WALL00000000000000000X', p)).toBe(70);
  });
  it('throws on an unknown GlobalId', () => {
    expect(() => resolveToId('NOPE00000000000000000X', p)).toThrow(/not found/);
  });
  it('throws on a non-existent express id / #id (not silently selecting nothing)', () => {
    expect(() => resolveToId('999999', p)).toThrow(/expressId not found/);
    expect(() => resolveToId('#999999', p)).toThrow(/expressId not found/);
  });
});

describe('forwardClosure', () => {
  it('pulls the whole reference subtree of a product', () => {
    const p = parseStep(MODEL);
    const keep = new Set<number>();
    forwardClosure([70], p, keep);
    // wall → placement chain (#50→#40→#21→#22), shape (#64→#63→#61→#60,#62), ctx (#20)
    for (const id of [70, 50, 40, 21, 22, 64, 63, 61, 60, 62, 20]) {
      expect(keep.has(id)).toBe(true);
    }
    // it must NOT drag in the unrelated wall #90
    expect(keep.has(90)).toBe(false);
  });
});

describe('buildSubset + serializeSubset', () => {
  const p = parseStep(MODEL);
  const keep = buildSubset(new Set([70]), p);

  it('includes the project + spatial context roots', () => {
    for (const id of [1, 20, 30, 31, 41]) expect(keep.has(id)).toBe(true);
  });

  it('keeps a containment relation whose members are ALL kept, drops one that references an unkept product', () => {
    // #80 references only #70 (kept) → included; #91 references #70 AND #90
    // (#90 not selected) → excluded to avoid a dangling reference.
    expect(keep.has(80)).toBe(true);
    expect(keep.has(91)).toBe(false);
    expect(keep.has(90)).toBe(false);
  });

  it('serializes a valid, self-contained STEP file with zero dangling references', () => {
    const out = serializeSubset(keep, p);
    expect(out).toContain('FILE_SCHEMA');
    expect(out.trimEnd().endsWith('END-ISO-10303-21;')).toBe(true);
    const defined = new Set<number>();
    for (const m of out.matchAll(/^#(\d+)=/gm)) defined.add(Number(m[1]));
    const data = out.slice(out.indexOf('DATA;'));
    for (const m of data.matchAll(/#(\d+)/g)) {
      expect(defined.has(Number(m[1]))).toBe(true);
    }
  });
});

// A wall with a window opening: IfcRelVoidsElement (rel → wall) points BACKWARD
// to the wall, and IfcRelFillsElement (rel → opening) to the filler window. The
// opening carries its own faceted-brep cutter body. Forward closure from the
// wall alone never reaches any of these.
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

describe('buildSubset — voids and fills', () => {
  const p = parseStep(VOID_MODEL);
  const keep = buildSubset(new Set([70]), p);

  it('pulls the backward IfcRelVoidsElement + its opening into a wall-only selection', () => {
    // The wall's forward closure never reaches these (the relation references
    // the wall, not vice-versa); without void inclusion the wall extracts as an
    // uncut box, hiding any void-cut defect.
    expect(keep.has(104)).toBe(true); // IfcRelVoidsElement
    expect(keep.has(103)).toBe(true); // IfcOpeningElement
    expect(keep.has(102)).toBe(true); // opening's shape (its cutter body)
    expect(keep.has(100)).toBe(true); // opening's extrusion
  });

  it('pulls the IfcRelFillsElement + its filler window once the opening is kept', () => {
    expect(keep.has(113)).toBe(true); // IfcRelFillsElement
    expect(keep.has(112)).toBe(true); // IfcWindow
    expect(keep.has(110)).toBe(true); // window shape
  });

  it('serializes with zero dangling references', () => {
    const out = serializeSubset(keep, p);
    const defined = new Set<number>();
    for (const m of out.matchAll(/^#(\d+)=/gm)) defined.add(Number(m[1]));
    const data = out.slice(out.indexOf('DATA;'));
    for (const m of data.matchAll(/#(\d+)/g)) expect(defined.has(Number(m[1]))).toBe(true);
  });
});

// Variant where each relation carries a DEDICATED IfcOwnerHistory (#11/#12)
// referenced by nothing else in the file. Closing over only the opening/filler
// (instead of the relation itself) used to leave these dangling in the subset.
const REL_OWNED_MODEL = VOID_MODEL.replace(
  "#104= IFCRELVOIDSELEMENT('VOID00000000000000000X',$,$,$,#70,#103);",
  "#11= IFCOWNERHISTORY(#13,#14,$,.NOCHANGE.,$,$,$,0);\n" +
    "#13= IFCPERSONANDORGANIZATION(#15,#16,$);\n" +
    "#15= IFCPERSON($,'p',$,$,$,$,$,$);\n" +
    "#16= IFCORGANIZATION($,'o',$,$,$);\n" +
    "#14= IFCAPPLICATION(#16,'1','app','app');\n" +
    "#104= IFCRELVOIDSELEMENT('VOID00000000000000000X',#11,$,$,#70,#103);",
).replace(
  "#113= IFCRELFILLSELEMENT('FILL00000000000000000X',$,$,$,#103,#112);",
  "#12= IFCOWNERHISTORY($,$,$,$,$,$,$,0);\n" +
    "#113= IFCRELFILLSELEMENT('FILL00000000000000000X',#12,$,$,#103,#112);",
);

describe('buildSubset — void/fill relations close over their own refs', () => {
  const p = parseStep(REL_OWNED_MODEL);
  const keep = buildSubset(new Set([70]), p);

  it('keeps a rel-only OwnerHistory (and its subtree) for both relation kinds', () => {
    for (const id of [11, 13, 14, 15, 16, 12]) expect(keep.has(id)).toBe(true);
  });

  it('serializes with zero dangling references', () => {
    const out = serializeSubset(keep, p);
    const defined = new Set<number>();
    for (const m of out.matchAll(/^#(\d+)=/gm)) defined.add(Number(m[1]));
    const data = out.slice(out.indexOf('DATA;'));
    for (const m of data.matchAll(/#(\d+)/g)) expect(defined.has(Number(m[1]))).toBe(true);
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

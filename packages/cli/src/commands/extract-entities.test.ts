/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeometryProcessor } from '@ifc-lite/geometry';
import {
  parseStep,
  resolveToId,
  forwardClosure,
  buildSubset,
  serializeSubset,
  scoreTriage,
  extractEntitiesCommand,
} from './extract-entities.js';
import { planSpatialRelations } from './subset-relations.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Committed viewer demo sample with real render geometry, needed for the
// `--detect` triage path (it meshes the model via GeometryProcessor).
const SAMPLE_IFC = join(__dirname, '../../../../apps/viewer/public/samples/hello-wall.ifc');

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

/**
 * The invariant every `serializeSubset` output must hold: every `#id` named
 * anywhere in the DATA section is DEFINED in that same section. Kept as one
 * helper because many tests assert it and only their setup differs, and no
 * caller should be able to assert a weaker version of it by hand. Deliberately
 * no count here: a count goes stale on the next commit that adds a caller.
 */
function expectNoDanglingRefs(out: string): void {
  const defined = new Set<number>();
  for (const m of out.matchAll(/^#(\d+)=/gm)) defined.add(Number(m[1]));
  // A `#` inside a STEP string literal is TEXT, not a reference: an exporter
  // writes names like `'Level #7'`. Strip literals first, with a REGEX rather
  // than the character scanner the production code uses, so this oracle cannot
  // inherit that scanner's blind spot.
  const data = out.slice(out.indexOf('DATA;')).replace(/'(?:[^']|'')*'/g, "''");
  let checked = 0;
  for (const m of data.matchAll(/#(\d+)/g)) {
    expect(defined.has(Number(m[1]))).toBe(true);
    checked++;
  }
  // A floor, because an output with NO instance lines carries no `#` at all: the
  // loop above then runs zero times and this helper reports success on an empty
  // file. Several of its callers assert nothing else about the text, so they
  // would carry no signal at all. One floor is enough: every `#n=` line sits after
  // `DATA;`, so it is counted here too and `defined` cannot be non-empty while
  // `checked` is zero.
  expect(checked).toBeGreaterThan(0);
}

// The oracle's own verdict, exercised. Without the floors above, this passes.
describe('expectNoDanglingRefs is not vacuous', () => {
  it('fails on a DATA section with no instance lines', () => {
    const empty = 'ISO-10303-21;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n';
    expect(() => expectNoDanglingRefs(empty)).toThrow();
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

  // #4148: a Name/Description literal containing `#<digits>` that happens to
  // match a REAL id in the model must not be read as a reference. Regression
  // for `forwardClosure` reading `/#(\d+)/g` over raw record text: unlike
  // `MODEL`'s `#north` above (not digits, never matched even the naive scan),
  // this fixture names an actual other entity's id inside a string.
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

  it('does not pull in an id that only appears inside a Name/Description string literal', () => {
    const p = parseStep(LOOKALIKE_MODEL);
    const keep = new Set<number>();
    forwardClosure([70], p, keep);
    expect(keep.has(70)).toBe(true);
    expect(keep.has(50)).toBe(true);
    // #71 is only mentioned inside #70's Name TEXT, never referenced as an
    // attribute — it and its own placement #51 must not be pulled in.
    expect(keep.has(71)).toBe(false);
    expect(keep.has(51)).toBe(false);
  });
});

describe('buildSubset + serializeSubset', () => {
  const p = parseStep(MODEL);
  const { keep, rewritten } = buildSubset(new Set([70]), p);

  it('includes the project + spatial context roots', () => {
    for (const id of [1, 20, 30, 31, 41]) expect(keep.has(id)).toBe(true);
  });

  it('keeps a containment relation whole when nothing was filtered, and rewrites one that names an unkept product', () => {
    // This used to assert that #91 was DROPPED. That was the defect pinned as
    // intended behaviour: #91's RelatedElements names #70 (kept) AND #90 (not
    // selected), and dropping the whole relation is what orphans every
    // extracted product on a real model. It is now kept with its SET rewritten
    // down to the kept members.
    expect(keep.has(80)).toBe(true);
    expect(rewritten.has(80)).toBe(false); // every member kept → byte-identical
    expect(keep.has(91)).toBe(true);
    expect(rewritten.get(91)).toContain('(#70)');
    expect(rewritten.get(91)).not.toContain('#90');
    // The unkept product itself is still not dragged in.
    expect(keep.has(90)).toBe(false);
  });

  it('serializes a valid, self-contained STEP file with zero dangling references', () => {
    const out = serializeSubset({ keep, rewritten }, p);
    expect(out).toContain('FILE_SCHEMA');
    expect(out.trimEnd().endsWith('END-ISO-10303-21;')).toBe(true);
    expectNoDanglingRefs(out);
  });
});

// The one case whose fixture this fix did NOT author. Every model above was
// written alongside the change, so the suite cannot catch a blind spot the
// fixtures share with it. `hello-wall.ifc` is a committed viewer sample and
// carries a real one-to-many containment,
// `#1223=IFCRELCONTAINEDINSPATIALSTRUCTURE(...,(#1262,#1222,#1407),#42)`, so
// selecting ONE of its three products is exactly the strict-subset shape the bug
// was about. On `main` the all-or-nothing rule drops #1223 here; this asserts the
// rewrite instead, which makes it a genuine before/after discriminator.
describe('buildSubset: a strict subset of a REAL committed model', () => {
  it('rewrites the sample containment down to the one selected product', async () => {
    const p = parseStep(await readFile(SAMPLE_IFC, 'latin1'));
    const { keep, rewritten } = buildSubset(new Set([1262]), p);

    expect(keep.has(1223)).toBe(true);
    expect(rewritten.get(1223)).toContain('(#1262)');
    for (const unkept of ['#1222', '#1407']) {
      expect(rewritten.get(1223)).not.toContain(unkept);
    }
    // RelatingStructure and GlobalId ride through untouched.
    expect(rewritten.get(1223)?.endsWith(',#42);')).toBe(true);
    expect(rewritten.get(1223)).toContain("'1wCUCVqEn6F9NR5qKQOzAp'");
    expectNoDanglingRefs(serializeSubset({ keep, rewritten }, p));
  });
});

// How a real exporter actually writes spatial structure, which the tiny MODEL
// above does not: ONE IfcRelContainedInSpatialStructure per storey naming EVERY
// product in it (issue: `extract-entities` dropped containment on every real
// model). Two storeys, four + two products, a shared IfcOwnerHistory (#5), the
// IfcRelAggregates project/site/building/storey chain, one
// IfcRelReferencedInSpatialStructure, and an element assembly whose whole is
// NOT selected.
const STOREY_MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2024',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('PROJ000000000000000001',#5,'Proj',$,$,$,$,(#20),#30);
#5= IFCOWNERHISTORY($,$,$,.NOCHANGE.,$,$,$,0);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#33= IFCLOCALPLACEMENT($,#21);
#34= IFCSITE('SITE000000000000000001',#5,'Site',$,$,#33,$,$,.ELEMENT.,$,$,$,$,$);
#35= IFCLOCALPLACEMENT(#33,#21);
#36= IFCBUILDING('BLDG000000000000000001',#5,'Bldg',$,$,#35,$,$,.ELEMENT.,$,$,$);
#40= IFCLOCALPLACEMENT(#35,#21);
#41= IFCBUILDINGSTOREY('STOR000000000000000001',#5,'L01',$,$,#40,$,$,.ELEMENT.,0.);
#44= IFCLOCALPLACEMENT(#35,#21);
#45= IFCBUILDINGSTOREY('STOR000000000000000002',#5,'L02',$,$,#44,$,$,.ELEMENT.,3.);
#50= IFCLOCALPLACEMENT(#40,#21);
#60= IFCRECTANGLEPROFILEDEF(.AREA.,$,#21,2.,0.2);
#61= IFCEXTRUDEDAREASOLID(#60,#21,#62,3.);
#62= IFCDIRECTION((0.,0.,1.));
#63= IFCSHAPEREPRESENTATION(#20,'Body','SweptSolid',(#61));
#64= IFCPRODUCTDEFINITIONSHAPE($,$,(#63));
#70= IFCFURNISHINGELEMENT('FURN000000000000000001',#5,'Chair 1',$,$,#50,#64,'c1');
#71= IFCFURNISHINGELEMENT('FURN000000000000000002',#5,'Chair 2',$,$,#50,#64,'c2');
#72= IFCFURNISHINGELEMENT('FURN000000000000000003',#5,'Chair 3',$,$,#50,#64,'c3');
#73= IFCFURNISHINGELEMENT('FURN000000000000000004',#5,'Chair 4',$,$,#50,#64,'c4');
#74= IFCFURNISHINGELEMENT('FURN000000000000000005',#5,'Chair 5',$,$,#50,#64,'c5');
#75= IFCFURNISHINGELEMENT('FURN000000000000000006',#5,'Chair 6',$,$,#50,#64,'c6');
#76= IFCELEMENTASSEMBLY('ASSY000000000000000001',#5,'Assembly',$,$,#50,$,'a1',$,.NOTDEFINED.);
#80= IFCRELCONTAINEDINSPATIALSTRUCTURE('RCON000000000000000001',#5,'L01 contents',$,(#70,#71,#72,#73),#41);
#82= IFCRELCONTAINEDINSPATIALSTRUCTURE('RCON000000000000000002',#5,'L02 contents',$,(#74,#75),#45);
#81= IFCRELREFERENCEDINSPATIALSTRUCTURE('RREF000000000000000001',#5,$,$,(#70,#71,#73),#34);
#93= IFCRELAGGREGATES('RAGG000000000000000004',#5,$,$,#76,(#70,#71));
#94= IFCRELAGGREGATES('RAGG000000000000000001',#5,$,$,#1,(#34));
#95= IFCRELAGGREGATES('RAGG000000000000000002',#5,$,$,#34,(#36));
#96= IFCRELAGGREGATES('RAGG000000000000000003',#5,$,$,#36,(#41,#45));
ENDSEC;
END-ISO-10303-21;
`;

describe('buildSubset: one containment relation per storey (the real exporter shape)', () => {
  const p = parseStep(STOREY_MODEL);
  // A STRICT subset of L01: two of its four products.
  const { keep, rewritten } = buildSubset(new Set([70, 72]), p);

  it('keeps the storey containment with only the selected products in RelatedElements', () => {
    expect(keep.has(80)).toBe(true);
    expect(rewritten.get(80)).toContain('(#70,#72)');
    for (const unkept of ['#71', '#73']) expect(rewritten.get(80)).not.toContain(unkept);
    // Everything OUTSIDE the rewritten set survives verbatim: the GlobalId, the
    // OwnerHistory, the Name, and RelatingStructure (the storey).
    expect(rewritten.get(80)).toContain("'RCON000000000000000001'");
    expect(rewritten.get(80)).toContain("'L01 contents'");
    expect(rewritten.get(80)?.endsWith(',#41);')).toBe(true);
    expect(keep.has(71)).toBe(false);
    expect(keep.has(73)).toBe(false);
  });

  it('drops a relation whose kept intersection is empty (the other storey)', () => {
    expect(keep.has(82)).toBe(false);
  });

  it('filters IfcRelReferencedInSpatialStructure the same way', () => {
    expect(keep.has(81)).toBe(true);
    expect(rewritten.get(81)).toContain('(#70)');
  });

  it('drops an aggregate whose RelatingObject is not kept, even though a part is', () => {
    // #93 aggregates the kept #70 under the UNSELECTED assembly #76: emitting it
    // would dangle on #76, and a part with no whole is meaningless anyway.
    expect(keep.has(93)).toBe(false);
    expect(keep.has(76)).toBe(false);
  });

  it('leaves the spatial IfcRelAggregates chain byte-identical (nothing filtered)', () => {
    for (const id of [94, 95, 96]) {
      expect(keep.has(id)).toBe(true);
      expect(rewritten.has(id)).toBe(false);
    }
  });

  it('serializes with zero dangling references, including the rewritten relations', () => {
    const out = serializeSubset({ keep, rewritten }, p);
    // The rewriting path included: #80 and #81 are emitted from `rewritten`,
    // not from their source lines.
    expectNoDanglingRefs(out);
    expect(out).toContain('#80=');
    // And the rewritten line is what actually landed in the file.
    expect(out).toContain('(#70,#72),#41);');
  });
});

// The IfcRelAggregates REWRITE path needs the whole kept AND a strict subset of
// its parts kept, and no selection above produces that shape: the spatial chain's
// parts (#34, #36, #41, #45) are force-kept context roots, so #94/#95/#96 never
// lose a member, and #93's whole #76 is never selected, so #93 is always dropped
// on its parent instead. Without this case the `IFCRELAGGREGATES: [4, 5]` row
// could be written backwards and every assertion above would still pass
// (measured: reversing that one row changes no verdict in the block above).
describe('buildSubset: an IfcRelAggregates keeping its whole and a strict subset of its parts', () => {
  const p = parseStep(STOREY_MODEL);
  // The assembly #76 AND one of its two parts. #71 is left out.
  const { keep, rewritten } = buildSubset(new Set([76, 70]), p);

  it('rewrites RelatedObjects and leaves RelatingObject alone', () => {
    expect(keep.has(76)).toBe(true);
    expect(keep.has(71)).toBe(false);
    expect(keep.has(93)).toBe(true);
    // The slot that shrank is the SET, not the parent. Pairing the two the other
    // way round makes `relationLine` read `(#70,#71)` as the relating parent,
    // fail `SINGLE_REF_RE`, fall back to keep-whole, and drop #93 on the unkept
    // #71, so `keep.has(93)` is what pins the orientation and the tail pins which
    // slot was written.
    expect(rewritten.get(93)?.endsWith(',#76,(#70));')).toBe(true);
    expect(rewritten.get(93)).not.toContain('#71');
    expect(rewritten.get(93)).toContain("'RAGG000000000000000004'");
  });

  it('serializes with zero dangling references', () => {
    const out = serializeSubset({ keep, rewritten }, p);
    expectNoDanglingRefs(out);
    expect(out).toContain(',#76,(#70));');
  });
});

// Same model, but the storey containment's Name carries a `#`: free text, and
// a real exporter does write names like this (`parseStep` tokenizes instead of
// regexing for exactly that reason). `#71` is a REAL id in this model that the
// selection does NOT keep, so reading the name as a reference drops the whole
// relation and orphans the storey again.
const STOREY_MODEL_HASH_IN_NAME = STOREY_MODEL.replace("'L01 contents'", "'L01 #71 contents'");

describe('buildSubset: a `#` inside a relation Name is TEXT, not a reference', () => {
  const p = parseStep(STOREY_MODEL_HASH_IN_NAME);
  const { keep, rewritten } = buildSubset(new Set([70, 72]), p);

  it('keeps the containment, name intact, instead of reading `#71` out of it', () => {
    expect(keep.has(71)).toBe(false);
    expect(keep.has(80)).toBe(true);
    expect(rewritten.get(80)).toContain("'L01 #71 contents'");
    expect(rewritten.get(80)).toContain('(#70,#72)');
  });

  // No serialization case here on purpose: `expectNoDanglingRefs` blanks every
  // string literal before scanning, and this fixture differs from STOREY_MODEL
  // only INSIDE one, on the same selection. The helper cannot tell the two
  // outputs apart, so such a test would re-run the block above's assertion. The
  // case above is the one that fails if `#71` is read out of the name.
});

// Same model, but the storey containment carries a DEDICATED IfcOwnerHistory
// (#6) that nothing else in the file references.
const STOREY_MODEL_REL_OWNED = STOREY_MODEL.replace(
  "#80= IFCRELCONTAINEDINSPATIALSTRUCTURE('RCON000000000000000001',#5,",
  "#6= IFCOWNERHISTORY($,$,$,.ADDED.,$,$,$,0);\n" +
    "#80= IFCRELCONTAINEDINSPATIALSTRUCTURE('RCON000000000000000001',#6,",
);

describe('buildSubset: a relation reference outside the rewritten SET', () => {
  const p = parseStep(STOREY_MODEL_REL_OWNED);
  const { keep, rewritten } = buildSubset(new Set([70, 72]), p);

  it('drops the relation rather than emitting a dangling OwnerHistory', () => {
    // #6 is reachable from nothing the subset keeps, and the rewrite only
    // touches RelatedElements, so emitting #80 would leave `#6` undefined.
    expect(keep.has(6)).toBe(false);
    expect(keep.has(80)).toBe(false);
  });

  it('serializes with zero dangling references', () => {
    const out = serializeSubset({ keep, rewritten }, p);
    expectNoDanglingRefs(out);
  });
});

describe('planSpatialRelations: a record it cannot scan, or cannot read as six attributes', () => {
  const record = (body: string) => ({
    id: 80,
    type: 'IFCRELCONTAINEDINSPATIALSTRUCTURE',
    body,
    full: `#80= IFCRELCONTAINEDINSPATIALSTRUCTURE(${body});`,
  });

  /** What actually lands in the file for this one record, given a kept set. */
  const emit = (inst: ReturnType<typeof record>, keep: Set<number>): string => {
    const plan = planSpatialRelations([inst], keep);
    return serializeSubset(
      { keep: new Set([...plan.add]), rewritten: plan.rewritten },
      { header: 'DATA;\n', instances: new Map([[inst.id, inst]]), guidToId: new Map() },
    );
  };

  // The SET has to sit at `relatedIdx` (4) for this to reach the COUNT check at
  // all. With the SET anywhere else the shape check at `relationLine` rejects the
  // record first and the count check is never consulted, so the test passes with
  // it deleted. Mutation-checked: removing `args.length !== STRUCTURE_RELATION_ATTRS`
  // fails the first assertion below and nothing else.
  it('falls back to keep-whole on a truncated attribute list, on the COUNT check', () => {
    // Five arguments, not six, DELIBERATELY arranged to put the SET at index 4.
    // This is not what dropping any one real attribute produces, and that matters:
    // `IfcRelContainedInSpatialStructure` is
    // `GlobalId, OwnerHistory, Name, Description, RelatedElements, RelatingStructure`,
    // so losing Description leaves the SET at index 3 and `#41` at index 4, which
    // the SHAPE check rejects before the count check is ever consulted. Measured:
    // with that realistic body the count check can be deleted and the whole file
    // still passes. So do NOT "correct" this body to look like a real truncation.
    // It has to reach the count check, and reaching it means the SET sits at
    // `relatedIdx` and index 5 does not exist, so without the count check
    // `args[5]` is undefined, no relating parent is found, and the record is
    // DROPPED rather than emitted verbatim.
    const truncated = record("'RCON000000000000000001',#5,$,#41,(#70)");
    expect(emit(truncated, new Set([5, 70, 41]))).toContain(truncated.full);
    expect(emit(truncated, new Set([5, 41]))).not.toContain('#80=');
  });

  // A plain `#70` in the related slot is caught by the MEMBER check further down
  // (stripping its first and last character leaves `7`, which `SINGLE_REF_RE`
  // rejects), so it does not pin the shape check at all. A quoted STRING does:
  // strip its first and last character and `#70,#71` looks exactly like a
  // two-member SET. Mutation-checked: removing the `startsWith('(') /
  // endsWith(')')` guard fails this and nothing else.
  it('falls back to keep-whole when the related slot is a STRING, on the SHAPE check', () => {
    // Six arguments, so the count check passes. Without the shape check the
    // quotes are stripped like parens, both members parse, `#71` is unkept, and a
    // shortened `(#70)` is spliced over what was a Name-shaped literal.
    const misshaped = record("'RCON000000000000000001',#5,$,$,'#70,#71',#41");
    expect(emit(misshaped, new Set([5, 41, 70, 71]))).toContain(misshaped.full);
    expect(emit(misshaped, new Set([5, 41, 70]))).not.toContain('#80=');
  });

  // Three ways a scan is not the record's attribute list. Each still yields
  // SIX parts under a LENIENT splitter, so the attribute-count check above does
  // not catch them: the split has to reject them itself, or the rewrite reads
  // RelatingStructure and writes RelatedElements at boundaries that are
  // wherever the scanner happened to stop (LTplus-AG/ifc-lite#2470).
  const MIS_SCANS: Array<[string, string]> = [
    ['a stray closing paren', "'RCON000000000000000001',#5,$,$,(#70),#41)"],
    ['an unbalanced list', "'RCON000000000000000001',#5,$,$,(#70,#71),(#41"],
    ['an unterminated string', "'RCON000000000000000001',#5,$,$,(#70,#71),'#41"],
  ];

  for (const [label, body] of MIS_SCANS) {
    it(`emits a record with ${label} verbatim, never spliced`, () => {
      const inst = record(body);
      const out = emit(inst, new Set([5, 41, 70, 71]));
      // `toContain(inst.full)` is the whole assertion, and it discriminates on all
      // three: under a lenient splitter the unterminated-string body drops the
      // record and this fails. A `not.toContain('(#70),#41);')` used to sit here
      // and was removed as vacuous, because two of these three bodies have every
      // member in the kept set, so `relationLine` returns `inst.full` whatever the
      // splitter does and that substring is unreachable by construction.
      expect(out).toContain(inst.full);
    });

    it(`drops a record with ${label} when one of its references is unkept`, () => {
      // The fallback is keep-WHOLE-or-drop-whole, not blanket keeping: #70 is
      // not kept here, so emitting the record would dangle.
      expect(emit(record(body), new Set([5, 41]))).not.toContain('#80=');
    });
  }
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
  const { keep, rewritten } = buildSubset(new Set([70]), p);

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
    const out = serializeSubset({ keep, rewritten }, p);
    expectNoDanglingRefs(out);
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
  const { keep, rewritten } = buildSubset(new Set([70]), p);

  it('keeps a rel-only OwnerHistory (and its subtree) for both relation kinds', () => {
    for (const id of [11, 13, 14, 15, 16, 12]) expect(keep.has(id)).toBe(true);
  });

  it('serializes with zero dangling references', () => {
    const out = serializeSubset({ keep, rewritten }, p);
    expectNoDanglingRefs(out);
  });
});

// Two storeys, each with its own placement chain and its own genuine wall —
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

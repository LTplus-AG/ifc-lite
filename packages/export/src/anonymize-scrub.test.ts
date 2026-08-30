/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `anonymize-scrub.ts` (#2934, the "anonymized isolated export" feature,
 * plan A5): pseudonym determinism, GlobalId regeneration into a `guidMap`
 * (never into the file), owner-history scrubbing, and `IfcTypeObject`
 * `HasPropertySets` clearing.
 *
 * Every scrub is verified end-to-end through a real fixture parsed with
 * `new IfcParser().parseColumnar` and re-read from a real `StepExporter`
 * export (`subsetEntityIds`), per this repo's "assert behaviour through a
 * real fixture" rule — never a mock store or a source-text assertion on
 * `anonymize-scrub.ts` itself. All identifiers below are synthetic.
 */

import { describe, expect, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { isValidIfcGuid, type RandomSource } from '@ifc-lite/encoding';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { getEffectiveEntityIndex } from './effective-index.js';
import { applyScrub, type ScrubOptions } from './anonymize-scrub.js';
import { StepExporter } from './step-exporter.js';
import { splitTopLevelArgs } from './step-argument-parser.js';
import { HAS_PROPERTY_SETS_SLOT } from './type-owned-psets.js';

const enc = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer;
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

async function parse(model: string): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(enc(model));
}

/** 22-char synthetic GlobalId, unique per `n` — same convention as
 *  `subset-mode.test.ts`. Deliberately NOT a valid IFC GlobalId encoding
 *  (arbitrary characters): the tests below never require an ORIGINAL
 *  GlobalId to validate, only that it does not survive and that its
 *  REPLACEMENT does. */
const guid = (n: number): string => `0GUID${String(n).padStart(17, '0')}`;

/** Small deterministic PRNG (`RandomSource`) so `guidRandom`-seeded runs are
 *  reproducible without touching the platform CSPRNG. */
function seededRandom(seed: number): RandomSource {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** Split one exported entity's line into its top-level STEP arguments (still
 *  raw tokens — quoted strings keep their quotes, `$` stays `$`). */
function lineArgs(content: string, id: number): string[] {
  // `.` excludes `\n` by default (no `s` flag), so this cannot run past this
  // entity's own line onto the next `#N=` record the way a `[\s\S]*` greedy
  // capture would.
  const match = content.match(new RegExp(`^#${id}=\\w+\\((.*)\\);$`, 'm'));
  if (!match) throw new Error(`no exported line for #${id}`);
  return splitTopLevelArgs(match[1]);
}

/**
 * Project #1 -> Storey #4 (IfcRelAggregates #30); Wall #5 ("Wall A", storey
 * #4 via IfcRelContainedInSpatialStructure #20 together with Wall #16
 * ("Wall B")); Wall #5's IfcWallType #6 (IfcRelDefinesByType #21) carries
 * `HasPropertySets` pointing at IfcPropertySet #7 ("Pset_WallTypeCommon",
 * holding IfcPropertySingleValue #8) — #7/#8 are deliberately NOT in
 * `INCLUDED_IDS`, so their absence from the export is the existing
 * `visibleOnly`-style dangling-ref protection, not this module's doing; what
 * IS this module's doing is that WallType #6's `HasPropertySets` slot reads
 * `$` rather than a now-dangling `(#7)`.
 *
 * Owner history: IfcOwnerHistory #10 -> IfcPersonAndOrganization #13 ->
 * IfcPerson #11 / IfcOrganization #12, plus IfcApplication #14 (kept,
 * per the decision doc). All four owner-history entities are
 * `INFRASTRUCTURE_TYPES` (`reference-collector.ts`), so they survive the
 * subset closure without needing to be in `INCLUDED_IDS` either.
 */
const MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('scrub-fixture.ifc','2024-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('${guid(1)}',#10,'Project One',$,$,$,$,$,#61);
#60=IFCMONETARYUNIT('NOK');
#61=IFCUNITASSIGNMENT((#60));
#4=IFCBUILDINGSTOREY('${guid(4)}',#10,'Storey One',$,$,$,$,$,$,0.);
#5=IFCWALL('${guid(5)}',#10,'Wall A',$,'Basic Wall: Northside School Exterior 300',$,#49,'TAG-A');
#40=IFCMATERIAL('Northside School Concrete',$,$);
#42=IFCMATERIALLAYER(#40,300.,$,'Northside School Layer',$,$,$);
#43=IFCMATERIALLAYERSET((#42),'Northside School Exterior Wall',$);
#41=IFCRELASSOCIATESMATERIAL('${guid(41)}',#10,$,$,(#5),#43);
#44=IFCSURFACESTYLE('Northside School - Covered Outdoor Area',.BOTH.,(#45));
#45=IFCSURFACESTYLERENDERING(#46,$,$,$,$,$,$,$,.FLAT.);
#46=IFCCOLOURRGB('Northside School Red',1.,0.,0.);
#47=IFCSTYLEDITEM(#48,(#44),$);
#48=IFCEXTRUDEDAREASOLID(#52,#53,#54,3000.);
#52=IFCRECTANGLEPROFILEDEF(.AREA.,'Northside School Profile',$,300.,5000.);
#53=IFCAXIS2PLACEMENT3D(#55,$,$);
#54=IFCDIRECTION((0.,0.,1.));
#55=IFCCARTESIANPOINT((0.,0.,0.));
#49=IFCPRODUCTDEFINITIONSHAPE($,$,(#50));
#50=IFCSHAPEREPRESENTATION(#51,'Body','SweptSolid',(#48));
#51=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#53,$);
#16=IFCWALL('${guid(16)}',#10,'Wall B',$,$,$,$,'TAG-B');
#6=IFCWALLTYPE('${guid(6)}',#10,'WallType A',$,$,(#7),$,$,$,.NOTDEFINED.);
#7=IFCPROPERTYSET('${guid(7)}',#10,'Pset_WallTypeCommon',$,(#8));
#8=IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.F.),$);
#10=IFCOWNERHISTORY(#13,#14,$,.NOCHANGE.,1700000001,$,$,1700000000);
#11=IFCPERSON('IDENT-1','Doe','Jane',$,$,$,$,$);
#12=IFCORGANIZATION($,'Acme Consulting','Structural Engineering',$,$);
#13=IFCPERSONANDORGANIZATION(#11,#12,$);
#14=IFCAPPLICATION(#12,'26.0.0 NOR FULL','ifc-lite','ifc-lite-export');
#20=IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid(20)}',#10,$,$,(#5,#16),#4);
#21=IFCRELDEFINESBYTYPE('${guid(21)}',#10,$,$,(#5),#6);
#30=IFCRELAGGREGATES('${guid(30)}',#10,$,$,#1,(#4));
ENDSEC;
END-ISO-10303-21;`;

/** Deliberately unsorted, so a test that passed only by Set-insertion order
 *  (rather than the ascending-expressId sort `applyScrub` documents) would
 *  fail. Every `IfcRoot` id this fixture's export needs: project, storey,
 *  both walls, the wall type, and the three relationships bridging them. */
const INCLUDED_IDS = new Set([30, 6, 21, 16, 1, 20, 4, 5, 41]);

/** Every string in the source fixture that identifies the ORIGINAL, real
 *  model — the residual-leak surface this feature exists to remove. */
const ORIGINAL_IDENTIFYING_STRINGS = [
  guid(1), guid(4), guid(5), guid(16), guid(6), guid(20), guid(21), guid(30), guid(41),
  'Project One', 'Storey One', 'Wall A', 'Wall B', 'WallType A', 'TAG-A', 'TAG-B',
  'IDENT-1', 'Doe', 'Jane', 'Acme Consulting', 'Structural Engineering',
  // Owner-history dates, the authoring tool's regional build string, currency.
  '1700000000', '1700000001', 'NOR FULL', 'NOK',
  // Non-IfcRoot names: a surface style or material named after the building
  // gives the project away as surely as IfcProject.Name does.
  'Northside School',
];

/** Build a fresh store + overlay + effective index for one test — never
 *  shared across `it`s, since `MutablePropertyView` mutations accumulate. */
async function freshFixture() {
  const store = await parse(MODEL);
  const view = new MutablePropertyView(null, 'anonymize');
  const index = getEffectiveEntityIndex(store, view, true);
  return { store, view, index };
}

function exportFixture(store: IfcDataStore, view: MutablePropertyView): string {
  return decode(
    new StepExporter(store, view).export({
      schema: 'IFC4',
      subsetEntityIds: INCLUDED_IDS,
      author: '',
      organization: '',
      authorization: '',
      timeStamp: '2024-01-01T00:00:00',
    }).content,
  );
}

describe('applyScrub: pseudonymized names, deterministic per type in ascending expressId order', () => {
  it('gives Wall #5 and Wall #16 distinct, ordinal pseudonyms on Name and Tag alike', async () => {
    const { store, view, index } = await freshFixture();
    applyScrub(store, index, INCLUDED_IDS, view, { guidRandom: seededRandom(1) });
    const content = exportFixture(store, view);

    // Name (index 2) and Tag (index 7) on IFCWALL.
    const wall5 = lineArgs(content, 5);
    const wall16 = lineArgs(content, 16);
    expect(wall5[2]).toBe("'IfcWall-1'");
    expect(wall5[7]).toBe("'IfcWall-1'");
    expect(wall16[2]).toBe("'IfcWall-2'");
    expect(wall16[7]).toBe("'IfcWall-2'");

    // Project and storey each get their own per-type counter, starting at 1.
    expect(lineArgs(content, 1)[2]).toBe("'IfcProject-1'");
    expect(lineArgs(content, 4)[2]).toBe("'IfcBuildingStorey-1'");
  });

  it('is stable across two independent runs over the same fixture (same seed)', async () => {
    const fixtureA = await freshFixture();
    applyScrub(fixtureA.store, fixtureA.index, INCLUDED_IDS, fixtureA.view, { guidRandom: seededRandom(7) });
    const contentA = exportFixture(fixtureA.store, fixtureA.view);

    const fixtureB = await freshFixture();
    applyScrub(fixtureB.store, fixtureB.index, INCLUDED_IDS, fixtureB.view, { guidRandom: seededRandom(7) });
    const contentB = exportFixture(fixtureB.store, fixtureB.view);

    expect(contentA).toBe(contentB);
  });

  it('leaves original Name/Tag values in place when pseudonymizeNames is false', async () => {
    const { store, view, index } = await freshFixture();
    applyScrub(store, index, INCLUDED_IDS, view, { pseudonymizeNames: false, guidRandom: seededRandom(1) });
    const content = exportFixture(store, view);

    expect(lineArgs(content, 5)[2]).toBe("'Wall A'");
    expect(lineArgs(content, 5)[7]).toBe("'TAG-A'");
  });
});

describe('applyScrub: pseudonymizeAllNames covers ObjectType and non-IfcRoot names (styles, materials, profiles)', () => {
  it('pseudonymizes IfcSurfaceStyle/IfcMaterial*/IfcProfileDef/IfcColourRgb names and IfcWall.ObjectType by default', async () => {
    const { store, view, index } = await freshFixture();
    applyScrub(store, index, INCLUDED_IDS, view, { guidRandom: seededRandom(1) });
    const content = exportFixture(store, view);

    expect(lineArgs(content, 5)[4]).toBe("'IfcWall-1'"); // ObjectType shares the root's pseudonym
    expect(lineArgs(content, 44)[0]).toBe("'IfcSurfaceStyle-1'");
    expect(lineArgs(content, 40)[0]).toBe("'IfcMaterial-1'");
    expect(lineArgs(content, 42)[3]).toBe("'IfcMaterialLayer-1'");
    expect(lineArgs(content, 43)[1]).toBe("'IfcMaterialLayerSet-1'"); // LayerSetName
    expect(lineArgs(content, 52)[1]).toBe("'IfcRectangleProfileDef-1'"); // ProfileName
    expect(lineArgs(content, 46)[0]).toBe("'IfcColourRgb-1'");
    // Enum-valued / semantic slots are untouched.
    expect(lineArgs(content, 44)[1]).toBe('.BOTH.');
    expect(lineArgs(content, 50)[1]).toBe("'Body'"); // RepresentationIdentifier is not a name slot
    expect(lineArgs(content, 51)[1]).toBe("'Model'"); // ContextType
    expect(lineArgs(content, 14)[2]).toBe("'ifc-lite'"); // IfcApplication exempt
  });

  it('leaves ObjectType and every non-IfcRoot name in place when pseudonymizeAllNames is false', async () => {
    const { store, view, index } = await freshFixture();
    applyScrub(store, index, INCLUDED_IDS, view, { pseudonymizeAllNames: false, guidRandom: seededRandom(1) });
    const content = exportFixture(store, view);

    expect(lineArgs(content, 5)[2]).toBe("'IfcWall-1'"); // root Name still pseudonymized
    expect(lineArgs(content, 5)[4]).toBe("'Basic Wall: Northside School Exterior 300'");
    expect(lineArgs(content, 44)[0]).toBe("'Northside School - Covered Outdoor Area'");
    expect(lineArgs(content, 40)[0]).toBe("'Northside School Concrete'");
  });

  it('is independent of pseudonymizeNames: root Name kept, style/material names still scrubbed', async () => {
    const { store, view, index } = await freshFixture();
    applyScrub(store, index, INCLUDED_IDS, view, { pseudonymizeNames: false, guidRandom: seededRandom(1) });
    const content = exportFixture(store, view);

    expect(lineArgs(content, 5)[2]).toBe("'Wall A'");
    expect(lineArgs(content, 5)[4]).toBe("'IfcWall-1'");
    expect(lineArgs(content, 44)[0]).toBe("'IfcSurfaceStyle-1'");
  });
});

describe('applyScrub: no original identifying string survives an otherwise-default scrub', () => {
  it('the exported file contains none of the source GUIDs, names, tags, or person/org fields', async () => {
    const { store, view, index } = await freshFixture();
    applyScrub(store, index, INCLUDED_IDS, view, { guidRandom: seededRandom(3) });
    const content = exportFixture(store, view);

    for (const needle of ORIGINAL_IDENTIFYING_STRINGS) {
      expect(content, `expected "${needle}" to be scrubbed from the export`).not.toContain(needle);
    }
  });
});

describe('applyScrub: guidMap', () => {
  it('maps every included IfcRoot\'s original GlobalId to a distinct, valid new one', async () => {
    const { store, view, index } = await freshFixture();
    const { guidMap } = applyScrub(store, index, INCLUDED_IDS, view, { guidRandom: seededRandom(5) });

    // One entry per IfcRoot id in INCLUDED_IDS — every id in this fixture's
    // set is IfcRoot-typed (project, storey, 2 walls, wall type, 3 rels).
    expect(guidMap.size).toBe(INCLUDED_IDS.size);

    const originalGuids = [1, 4, 5, 16, 6, 20, 21, 30].map(guid);
    for (const original of originalGuids) {
      const replacement = guidMap.get(original);
      expect(replacement, `expected guidMap to carry an entry for ${original}`).toBeDefined();
      expect(isValidIfcGuid(replacement!)).toBe(true);
      expect(replacement).not.toBe(original);
    }

    // Every replacement is unique (no two entities collided onto one guid).
    expect(new Set(guidMap.values()).size).toBe(guidMap.size);
  });

  it('is empty when regenerateGlobalIds is false, and the exported GlobalIds are unchanged', async () => {
    const { store, view, index } = await freshFixture();
    const { guidMap } = applyScrub(store, index, INCLUDED_IDS, view, { regenerateGlobalIds: false });
    expect(guidMap.size).toBe(0);

    const content = exportFixture(store, view);
    expect(lineArgs(content, 5)[0]).toBe(`'${guid(5)}'`);
  });
});

describe('applyScrub: owner history', () => {
  it("blanks every IfcPerson attribute except FamilyName, which becomes 'Anonymous'", async () => {
    const { store, view, index } = await freshFixture();
    applyScrub(store, index, INCLUDED_IDS, view, { guidRandom: seededRandom(2) });
    const content = exportFixture(store, view);

    // IFCPERSON: Identification, FamilyName, GivenName, MiddleNames,
    // PrefixTitles, SuffixTitles, Roles, Addresses.
    const person = lineArgs(content, 11);
    expect(person[1]).toBe("'Anonymous'");
    expect(person.filter((_, i) => i !== 1).every((arg) => arg === '$')).toBe(true);
  });

  it('satisfies IfcPerson\'s IdentifiablePersonName WHERE rule and drops the original name', async () => {
    const { store, view, index } = await freshFixture();
    applyScrub(store, index, INCLUDED_IDS, view, { guidRandom: seededRandom(2) });
    const content = exportFixture(store, view);

    // IdentifiablePersonName: at least one of Identification, FamilyName, or
    // GivenName must be set (not `$`) — a total wipe would violate it.
    const [identification, familyName, givenName] = lineArgs(content, 11);
    expect([identification, familyName, givenName].some((arg) => arg !== '$')).toBe(true);
    expect(familyName).toBe("'Anonymous'");
    expect(content).not.toContain("'Doe'");
    expect(content).not.toContain("'Jane'");
    expect(content).not.toContain("'IDENT-1'");
  });

  it("sets IfcOrganization.Name to 'Anonymous' and blanks every other attribute", async () => {
    const { store, view, index } = await freshFixture();
    applyScrub(store, index, INCLUDED_IDS, view, { guidRandom: seededRandom(2) });
    const content = exportFixture(store, view);

    const org = lineArgs(content, 12);
    // IFCORGANIZATION: Identification, Name, Description, Roles, Addresses.
    expect(org[1]).toBe("'Anonymous'");
    expect(org[0]).toBe('$');
    expect(org[2]).toBe('$');
    expect(org[3]).toBe('$');
    expect(org[4]).toBe('$');
  });

  it('blanks IfcPersonAndOrganization.Roles but keeps ThePerson/TheOrganization refs', async () => {
    const { store, view, index } = await freshFixture();
    applyScrub(store, index, INCLUDED_IDS, view, { guidRandom: seededRandom(2) });
    const content = exportFixture(store, view);

    const personAndOrg = lineArgs(content, 13);
    expect(personAndOrg[0]).toBe('#11');
    expect(personAndOrg[1]).toBe('#12');
    expect(personAndOrg[2]).toBe('$');
  });

  it('zeroes IfcOwnerHistory.CreationDate and blanks LastModifiedDate', async () => {
    const { store, view, index } = await freshFixture();
    applyScrub(store, index, INCLUDED_IDS, view, { guidRandom: seededRandom(1) });
    const args = lineArgs(exportFixture(store, view), 10);
    expect(args[4]).toBe('$'); // LastModifiedDate
    expect(args[7]).toBe('0'); // CreationDate (mandatory INTEGER, so 0 not $)
    expect(args[3]).toBe('.NOCHANGE.'); // ChangeAction untouched
  });

  it("blanks IfcApplication.Version (regional build string) but keeps the tool's name and identifier", async () => {
    const { store, view, index } = await freshFixture();
    applyScrub(store, index, INCLUDED_IDS, view, { guidRandom: seededRandom(1) });
    const args = lineArgs(exportFixture(store, view), 14);
    expect(args[1]).toBe('$');
    expect(args[2]).toBe("'ifc-lite'");
    expect(args[3]).toBe("'ifc-lite-export'");
  });

  it('rewrites IfcMonetaryUnit.Currency to USD in the schema\'s own spelling, and keeps it when neutralizeCurrency is false', async () => {
    const a = await freshFixture();
    applyScrub(a.store, a.index, INCLUDED_IDS, a.view, { guidRandom: seededRandom(1) });
    expect(lineArgs(exportFixture(a.store, a.view), 60)[0]).toBe("'USD'"); // IFC4: IfcLabel

    const b = await freshFixture();
    applyScrub(b.store, b.index, INCLUDED_IDS, b.view, { neutralizeCurrency: false, guidRandom: seededRandom(1) });
    expect(lineArgs(exportFixture(b.store, b.view), 60)[0]).toBe("'NOK'");
  });

  it('does nothing when scrubOwnerHistory is false', async () => {
    const { store, view, index } = await freshFixture();
    applyScrub(store, index, INCLUDED_IDS, view, { scrubOwnerHistory: false, guidRandom: seededRandom(2) });
    const content = exportFixture(store, view);

    expect(lineArgs(content, 11)).toEqual(["'IDENT-1'", "'Doe'", "'Jane'", '$', '$', '$', '$', '$']);
    expect(lineArgs(content, 12)[1]).toBe("'Acme Consulting'");
  });
});

describe('applyScrub: IfcTypeObject.HasPropertySets', () => {
  it('clears the HasPropertySets slot to $ by default', async () => {
    const { store, view, index } = await freshFixture();
    applyScrub(store, index, INCLUDED_IDS, view, { guidRandom: seededRandom(4) });
    const content = exportFixture(store, view);

    expect(lineArgs(content, 6)[HAS_PROPERTY_SETS_SLOT]).toBe('$');
  });

  it('keeps the original HasPropertySets list when keepPropertySets is true', async () => {
    const { store, view, index } = await freshFixture();
    applyScrub(store, index, INCLUDED_IDS, view, { keepPropertySets: true, guidRandom: seededRandom(4) });
    const content = exportFixture(store, view);

    expect(lineArgs(content, 6)[HAS_PROPERTY_SETS_SLOT]).toBe('(#7)');
  });
});

describe('applyScrub: return value', () => {
  it('scrubbedCount covers every scrubbed IfcRoot, owner-history entity, and non-root named entity', async () => {
    const { store, view, index } = await freshFixture();
    const result = applyScrub(store, index, INCLUDED_IDS, view, { guidRandom: seededRandom(6) });

    // 9 IfcRoot ids in INCLUDED_IDS + IfcPerson + IfcOrganization +
    // IfcPersonAndOrganization + IfcOwnerHistory (dates) + IfcApplication
    // (version) + IfcMonetaryUnit (currency) + 6 non-root entities with a
    // quoted name (material #40, layer #42, layer set #43, surface style #44,
    // colour #46, profile #52).
    expect(result.scrubbedCount).toBe(INCLUDED_IDS.size + 6 + 6);
    expect(result.warnings).toEqual([]);
  });

  it('scrubbedCount excludes non-root names when pseudonymizeAllNames is false', async () => {
    const { store, view, index } = await freshFixture();
    const result = applyScrub(store, index, INCLUDED_IDS, view, { pseudonymizeAllNames: false, guidRandom: seededRandom(6) });
    expect(result.scrubbedCount).toBe(INCLUDED_IDS.size + 6);
  });

  it('accepts no options at all and still scrubs (every default is the scrubbed direction)', async () => {
    const { store, view, index } = await freshFixture();
    const options: ScrubOptions = {};
    const result = applyScrub(store, index, INCLUDED_IDS, view, options);
    expect(result.guidMap.size).toBe(INCLUDED_IDS.size);

    const content = exportFixture(store, view);
    expect(content).not.toContain('Wall A');
  });
});

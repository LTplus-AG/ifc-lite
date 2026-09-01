/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `exportAnonymizedSubset` (#2934, the "anonymized isolated export" feature,
 * plan A6): the orchestrator's own end-to-end invariants, on top of what
 * `related-entities.test.ts`, `anonymize-placement.test.ts` and
 * `anonymize-scrub.test.ts` already cover for their own modules in
 * isolation. Every assertion here reads the FINAL, RE-EXPORTED STEP text (or
 * a re-parse of it), never the private overlay's internal state — per this
 * repo's "assert behaviour through a real fixture" rule.
 *
 * One shared, richly-populated fixture (`FIXTURE_MODEL`) plays the role the
 * plan describes: project → site → building → 2 storeys; a georeferenced,
 * non-identity-rotated site placement; `IfcMapConversion`/`IfcProjectedCRS`;
 * a `IfcPostalAddress`-bearing site and building; a person/org owner-history
 * chain with a telecom address; Wall A (storey 1) with an opening + window,
 * an `IfcWallType` carrying its own property set, and a geometry
 * representation; Wall B (storey 2), sharing a material with Wall A and
 * structurally connected to it; an occurrence-level `Pset_WallCommon`
 * spanning both walls; an `IfcElementAssembly` aggregating a plate; and a
 * third wall on an `IfcGridPlacement` this feature cannot safely zero. All
 * values are synthetic and were invented for this fixture.
 *
 * Different `it`s pass DIFFERENT `includedIds` subsets of this one model —
 * the same pattern `subset-mode.test.ts` and `anonymize-scrub.test.ts` use —
 * so a scenario that needs an entity excluded (to prove trimming or pruning)
 * does not have to be a second fixture.
 */

import { describe, expect, it } from 'vitest';
import { EMPTY_SOURCE_BYTES, IfcParser, parseSourceHeader, type IfcDataStore } from '@ifc-lite/parser';
import { isValidIfcGuid, type RandomSource } from '@ifc-lite/encoding';
import { exportAnonymizedSubset } from './anonymize-export.js';
import type { AnonymizeOptions } from './anonymize-types.js';
import { splitTopLevelArgs } from './step-argument-parser.js';
import { HAS_PROPERTY_SETS_SLOT } from './type-owned-psets.js';

const enc = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer;
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

async function parse(model: string): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(enc(model));
}

/** 22-char synthetic GlobalId, deterministic and unique per `n` — same
 *  convention as the sibling module test files. */
const guid = (n: number): string => `0GUID${String(n).padStart(17, '0')}`;

/** Small deterministic PRNG (`RandomSource`), so a seeded run is
 *  reproducible without touching the platform CSPRNG. */
function seededRandom(seed: number): RandomSource {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** Every `#N` referenced in the output that has no `#N=` defining line —
 *  same helper as `subset-mode.test.ts` / `anonymize-placement.test.ts`. */
function findDanglingRefs(content: string): number[] {
  const defined = new Set<number>();
  for (const m of content.matchAll(/(^|\n)#(\d+)=/g)) defined.add(+m[2]);
  const dangling = new Set<number>();
  for (const m of content.matchAll(/#(\d+)/g)) {
    const id = +m[1];
    if (!defined.has(id)) dangling.add(id);
  }
  return [...dangling].sort((a, b) => a - b);
}

/** Split one exported entity's line into its top-level STEP arguments —
 *  same helper as `anonymize-scrub.test.ts`. */
function lineArgs(content: string, id: number): string[] {
  const match = content.match(new RegExp(`^#${id}=\\w+\\((.*)\\);$`, 'm'));
  if (!match) throw new Error(`no exported line for #${id}`);
  return splitTopLevelArgs(match[1]);
}

/**
 * Placement chain: #20 = root `IfcLocalPlacement` (`PlacementRelTo = $`) →
 * #21 → Location #22 = `(1000.,2000.,30.)`, RefDirection #23 = a non-trivial
 * rotation. #24/#25 is the BUILDING's placement, a CHILD of #20
 * (`PlacementRelTo = #20`) that shares the SAME point #22 — deliberately, to
 * prove the shared point is never rewritten (clone, never rewrite) and the
 * child chain survives byte-identical. #55 is an `IfcGridPlacement`, a root
 * kind this feature cannot safely zero (Wall G sits on it).
 *
 * Owner history: #74 → #72 (person+org) → #70 (person, with a telecom
 * address #54) / #71 (org). #73 is `IfcApplication`, kept per the decision
 * doc.
 *
 * Georeferencing: Site #2 carries `RefLatitude`/`RefLongitude`/
 * `RefElevation`/`LandTitleNumber`/`SiteAddress` (#50, `IfcPostalAddress`);
 * Building #3 carries `BuildingAddress` (#51). #52/#53
 * (`IfcProjectedCRS`/`IfcMapConversion`) are present but reached by nothing
 * an included entity ever references — `IDENTIFYING_TYPES` excludes them
 * regardless of `includedIds`.
 *
 * Wall A (#6, storey 1) has a geometry representation (#100/#101/#102/#103),
 * an opening (#8) filled by a window (#9), an `IfcWallType` (#10) carrying
 * its own `Pset_WallTypeCommon` (#11/#12), and shares `Pset_WallCommon`
 * (#13/#15/#14, via #89) and a material (#40, via #44) with Wall B (#7, storey
 * 2). #88 structurally connects the two walls. #90 (`IfcElementAssembly`)
 * aggregates a plate (#91) via #92.
 */
const FIXTURE_MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('anonymize-export-fixture.ifc','2020-01-01T00:00:00',('Source Header Author'),('Source Header Org'),'Source Preprocessor','Source Originating System','source-auth-token');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#54=IFCTELECOMADDRESS($,$,$,$,$,$,('nyx.umbriel@example-fictitious.test'),$,$);
#70=IFCPERSON('IDENT-ALPHA-1','Umbriel','Nyx',$,$,$,$,(#54));
#71=IFCORGANIZATION($,'Acme Aerospace Consortium','Structural Dynamics Division',$,$);
#72=IFCPERSONANDORGANIZATION(#70,#71,$);
#73=IFCAPPLICATION(#71,'1.0','ifc-lite','ifc-lite-export');
#74=IFCOWNERHISTORY(#72,#73,$,.NOCHANGE.,$,$,$,0);
#20=IFCLOCALPLACEMENT($,#21);
#21=IFCAXIS2PLACEMENT3D(#22,$,#23);
#22=IFCCARTESIANPOINT((1000.,2000.,30.));
#23=IFCDIRECTION((0.7071067811865476,0.7071067811865475,0.));
#24=IFCLOCALPLACEMENT(#20,#25);
#25=IFCAXIS2PLACEMENT3D(#22,$,$);
#55=IFCGRIDPLACEMENT($,$,$);
#60=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#61,$);
#61=IFCAXIS2PLACEMENT3D(#62,$,$);
#62=IFCCARTESIANPOINT((0.,0.,0.));
#100=IFCPRODUCTDEFINITIONSHAPE($,$,(#101));
#101=IFCSHAPEREPRESENTATION(#60,'Body','Point',(#102,#103));
#102=IFCCARTESIANPOINT((1.,1.,1.));
#103=IFCCARTESIANPOINT((2.,2.,2.));
#1=IFCPROJECT('${guid(1)}',#74,'Project Zephyr',$,$,$,$,$,$);
#2=IFCSITE('${guid(2)}',#74,'Site Meridian',$,$,#20,$,$,.ELEMENT.,(47,22,12,0),(8,32,0,0),408.,'TITLE-PARCEL-9182',#50);
#3=IFCBUILDING('${guid(3)}',#74,'Building Solstice',$,$,#24,$,$,.ELEMENT.,$,$,#51);
#4=IFCBUILDINGSTOREY('${guid(4)}',#74,'Storey Boreal',$,$,$,$,$,$,0.);
#5=IFCBUILDINGSTOREY('${guid(5)}',#74,'Storey Austral',$,$,$,$,$,$,3.);
#6=IFCWALL('${guid(6)}',#74,'Wall Umbra',$,$,$,#100,'TAG-UMBRA');
#7=IFCWALL('${guid(7)}',#74,'Wall Penumbra',$,$,$,$,'TAG-PENUMBRA');
#16=IFCWALL('${guid(16)}',#74,'Wall Gridline',$,$,#55,$,'TAG-GRIDLINE');
#8=IFCOPENINGELEMENT('${guid(8)}',#74,'Opening Aperture',$,$,$,$,$);
#9=IFCWINDOW('${guid(9)}',#74,'Window Lucent',$,$,$,$,'TAG-LUCENT',1.,1.);
#10=IFCWALLTYPE('${guid(10)}',#74,'WallType Solace',$,'Occurrence Vermilion',(#11),$,$,'ElementType Cerulean',.NOTDEFINED.);
#11=IFCPROPERTYSET('${guid(11)}',#74,'Pset_WallTypeCommon',$,(#12));
#12=IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.F.),$);
#13=IFCPROPERTYSET('${guid(13)}',#74,'Pset_WallCommon',$,(#15,#14));
#15=IFCPROPERTYSINGLEVALUE('LoadBearing',$,IFCBOOLEAN(.T.),$);
#14=IFCPROPERTYSINGLEVALUE('Owner',$,IFCTEXT('jane.doe@acme-corp.example'),$);
#40=IFCMATERIAL('Concrete',$,'Category Marigold');
#90=IFCELEMENTASSEMBLY('${guid(90)}',#74,'Assembly Cobalt',$,$,$,$,$,$,.RIGID.);
#91=IFCPLATE('${guid(91)}',#74,'Plate Vertex',$,$,$,$,$,$);
#95=IFCPROPERTYSET('${guid(95)}',#74,'Pset_AddressRef',$,(#96));
#96=IFCPROPERTYREFERENCEVALUE('AddressRef',$,$,#51);
#97=IFCRELDEFINESBYPROPERTIES('${guid(97)}',#74,$,$,(#6),#95);
#50=IFCPOSTALADDRESS($,$,$,$,('742 Fictitious Lane'),$,'Fictitious Falls','Fictitious Province','00000','Fictitious Country');
#51=IFCPOSTALADDRESS($,$,$,$,('99 Imaginary Boulevard'),$,'Imaginary Heights','Imaginary Province','11111','Imaginary Country');
#52=IFCPROJECTEDCRS('EPSG:FICTITIOUS-9999',$,$,$,$,$,$);
#53=IFCMAPCONVERSION(#60,#52,500000.,6000000.,0.,1.,0.,1.);
#44=IFCRELASSOCIATESMATERIAL('${guid(44)}',#74,$,$,(#6,#7),#40);
#80=IFCRELVOIDSELEMENT('${guid(80)}',#74,$,$,#6,#8);
#81=IFCRELFILLSELEMENT('${guid(81)}',#74,$,$,#8,#9);
#82=IFCRELDEFINESBYTYPE('${guid(82)}',#74,$,$,(#6),#10);
#83=IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid(83)}',#74,$,$,(#6,#16),#4);
#84=IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid(84)}',#74,$,$,(#7),#5);
#85=IFCRELAGGREGATES('${guid(85)}',#74,$,$,#1,(#2));
#86=IFCRELAGGREGATES('${guid(86)}',#74,$,$,#2,(#3));
#87=IFCRELAGGREGATES('${guid(87)}',#74,$,$,#3,(#4,#5));
#88=IFCRELCONNECTSPATHELEMENTS('${guid(88)}',#74,$,$,$,#6,#7,(),(),.ATSTART.,.ATEND.);
#89=IFCRELDEFINESBYPROPERTIES('${guid(89)}',#74,$,$,(#6,#7),#13);
#92=IFCRELAGGREGATES('${guid(92)}',#74,$,$,#90,(#91));
ENDSEC;
END-ISO-10303-21;`;

/** A realistic "reproduce this bug" selection: project, site, building, both
 *  storeys, all three walls, the opening/window, the wall type, the shared
 *  material association, the full relationship graph connecting them, and
 *  the assembly/plate pair. Deliberately EXCLUDES the standalone
 *  `Pset_WallCommon` (#13/#15/#14/#89) and the wall type's own pset (#11/#12) —
 *  psets are dropped by default, the same way a caller's own
 *  `RelatedEntityOptions.IfcRelDefinesByProperties` default (`false`) would
 *  never have added them to `includedIds` in the first place. Every id here
 *  is `IfcRoot`-typed. */
const FULL_INCLUDED_IDS = new Set([
  1, 2, 3, 4, 5, 6, 7, 16, 8, 9, 10, 44,
  80, 81, 82, 83, 84, 85, 86, 87, 88, 90, 91, 92,
]);

/** Every string in the source fixture that identifies the ORIGINAL model —
 *  names, tags, person/org fields, and address/georeferencing text — for
 *  every entity `FULL_INCLUDED_IDS` reaches (directly or via the closure). */
const ORIGINAL_IDENTIFYING_STRINGS = [
  // Slots that used to be `$` in this fixture, so the sweep below could not
  // fail on them however badly the scrubber leaked (#3351).
  'ElementType Cerulean',
  'Occurrence Vermilion',
  'Category Marigold',
  'Project Zephyr', 'Site Meridian', 'Building Solstice', 'Storey Boreal', 'Storey Austral',
  'Wall Umbra', 'Wall Penumbra', 'Wall Gridline', 'Opening Aperture', 'Window Lucent',
  'WallType Solace', 'Assembly Cobalt', 'Plate Vertex',
  'TAG-UMBRA', 'TAG-PENUMBRA', 'TAG-GRIDLINE', 'TAG-LUCENT',
  'Umbriel', 'Nyx', 'Acme Aerospace Consortium', 'Structural Dynamics Division', 'IDENT-ALPHA-1',
  'nyx.umbriel@example-fictitious.test',
  'TITLE-PARCEL-9182', '742 Fictitious Lane', 'Fictitious Falls', 'Fictitious Province',
  '99 Imaginary Boulevard', 'Imaginary Heights', 'Imaginary Province',
  'EPSG:FICTITIOUS-9999',
];

async function runFullExport(options: AnonymizeOptions = {}) {
  const store = await parse(FIXTURE_MODEL);
  const result = exportAnonymizedSubset(store, FULL_INCLUDED_IDS, options);
  return { result, content: decode(result.content) };
}

describe('exportAnonymizedSubset — full-subset export invariants (#2934 A6)', () => {
  it('emits no dangling references', async () => {
    const { content } = await runFullExport({ guidRandom: seededRandom(1) });
    expect(findDanglingRefs(content)).toEqual([]);
  });

  it('emits no dangling references when georeferencing is KEPT', async () => {
    // The option-off path had no test at all, and it produced an invalid STEP
    // file: `IfcSite.SiteAddress` referenced `#51`, which `IDENTIFYING_TYPES`
    // dropped unconditionally, and `warnings` came back empty (#3351). The
    // dangling-ref repair only rewrites `IFCREL*` lines, so it never saw a
    // direct attribute slot.
    const { result, content } = await runFullExport({
      guidRandom: seededRandom(11),
      removeGeoreferencing: false,
    });
    expect(findDanglingRefs(content)).toEqual([]);
    // ...and KEPT has to mean kept. Blanking the slot would also satisfy the
    // assertion above while doing the opposite of what the option asks for.
    expect(content).toContain('IFCPOSTALADDRESS');
    expect(content).toContain('IFCMAPCONVERSION');
    expect(content).toContain('IFCPROJECTEDCRS');
    // Not `warnings).toEqual([])`: this fixture legitimately warns about an
    // IfcGridPlacement root it cannot zero, which has nothing to do with
    // georeferencing. Assert the absence of THIS defect's warning class rather
    // than the absence of all warnings, or the row fails for an unrelated
    // reason and gets "fixed" by loosening it.
    for (const w of result.stats.warnings) {
      expect(w).not.toMatch(/address|dangl|unresolved/i);
    }
  });

  it('still drops the address when georeferencing is REMOVED (the default)', async () => {
    // The other direction, so the branch above cannot be satisfied by simply
    // never dropping anything.
    const { content } = await runFullExport({ guidRandom: seededRandom(12) });
    expect(content).not.toContain('IFCPOSTALADDRESS');
    expect(findDanglingRefs(content)).toEqual([]);
  });

  it('contains none of the source model\'s identifying strings', async () => {
    const { content } = await runFullExport({ guidRandom: seededRandom(2) });
    for (const needle of ORIGINAL_IDENTIFYING_STRINGS) {
      expect(content, `expected "${needle}" to be scrubbed from the export`).not.toContain(needle);
    }
  });

  it('maps every included IfcRoot\'s GlobalId to a distinct, valid new one, and no original GlobalId survives', async () => {
    const { result, content } = await runFullExport({ guidRandom: seededRandom(3) });
    expect(result.guidMap.size).toBe(FULL_INCLUDED_IDS.size);

    const originals = [...FULL_INCLUDED_IDS].map(guid);
    for (const original of originals) {
      const replacement = result.guidMap.get(original);
      expect(replacement, `expected guidMap entry for ${original}`).toBeDefined();
      expect(isValidIfcGuid(replacement!)).toBe(true);
      expect(content).not.toContain(`'${original}'`);
    }
    // Every replacement is unique (no two entities collided onto one guid).
    expect(new Set(result.guidMap.values()).size).toBe(result.guidMap.size);
  });

  it('zeroes the site\'s root placement translation, keeps its rotation, and leaves the building\'s child placement byte-identical', async () => {
    const { result, content } = await runFullExport({ guidRandom: seededRandom(4) });

    expect(result.stats.zeroedPlacements).toEqual([{ expressId: 20, translation: [1000, 2000, 30] }]);

    const rootLine = content.match(/^#20=IFCLOCALPLACEMENT\(([^)]*)\);$/m);
    expect(rootLine).not.toBeNull();
    expect(rootLine![1]).not.toContain('#21'); // repointed at a clone, never rewritten in place

    const newAxisId = rootLine![1].split(',')[1];
    const newAxisLine = content.match(new RegExp(`^${newAxisId}=IFCAXIS2PLACEMENT3D\\(([^)]*)\\);$`, 'm'));
    expect(newAxisLine).not.toBeNull();
    const [, , refDirTok] = newAxisLine![1].split(',');
    expect(refDirTok).toBe('#23'); // the rotation carried over verbatim
    expect(content).toContain('#23=IFCDIRECTION((0.7071067811865476,0.7071067811865475,0.));');

    // The building's own child placement chain, reached only through the
    // untouched #30/#31 shape, is completely unaffected.
    expect(content).toContain('#24=IFCLOCALPLACEMENT(#20,#25);');
    expect(content).toContain('#25=IFCAXIS2PLACEMENT3D(#22,$,$);');
    expect(content).toContain('#22=IFCCARTESIANPOINT((1000.,2000.,30.));');
  });

  it('removes georeferencing/address entities and blanks Site/Building georeferencing attributes', async () => {
    const { content } = await runFullExport({ guidRandom: seededRandom(5) });

    expect(content).not.toContain('IFCPOSTALADDRESS');
    expect(content).not.toContain('IFCPROJECTEDCRS');
    expect(content).not.toContain('IFCMAPCONVERSION');

    const site = lineArgs(content, 2);
    // RefLatitude, RefLongitude, RefElevation, LandTitleNumber, SiteAddress.
    expect(site.slice(9, 14)).toEqual(['$', '$', '$', '$', '$']);

    const building = lineArgs(content, 3);
    expect(building[11]).toBe('$'); // BuildingAddress
  });

  it('preserves the wall\'s geometry representation entity count across export and re-parse', async () => {
    const source = await parse(FIXTURE_MODEL);
    const sourceShapeReps = source.entityIndex.byType.get('IFCSHAPEREPRESENTATION')?.length ?? 0;
    expect(sourceShapeReps).toBeGreaterThan(0);

    const result = exportAnonymizedSubset(source, FULL_INCLUDED_IDS, { guidRandom: seededRandom(6) });
    const content = decode(result.content);
    const reparsed = await parse(content);
    const exportedShapeReps = reparsed.entityIndex.byType.get('IFCSHAPEREPRESENTATION')?.length ?? 0;

    expect(exportedShapeReps).toBe(sourceShapeReps);
    // Geometry itself is untouched by anonymization — the representation
    // items survive verbatim, not merely in the same count.
    expect(content).toContain('#102=IFCCARTESIANPOINT((1.,1.,1.));');
    expect(content).toContain('#103=IFCCARTESIANPOINT((2.,2.,2.));');
  });

  it('blanks header author/organization/authorization, keeps originating_system, and stamps the anonymized filename', async () => {
    const { result } = await runFullExport({ timeStamp: '2024-06-01T00:00:00', guidRandom: seededRandom(7) });
    const out = parseSourceHeader(result.content);
    expect(out).not.toBeNull();

    expect(out!.author).toEqual(['']);
    expect(out!.organization).toEqual(['']);
    expect(out!.authorization).toBe('');
    expect(out!.authorization).not.toBe('source-auth-token');
    expect(out!.name).toBe('anonymized.ifc');
    expect(out!.timeStamp).toBe('2024-06-01T00:00:00');
    // preprocessor_version names the tool that WROTE this file (ifc-lite,
    // never the source's). originating_system is the AUTHORING tool's build
    // string — one vendor writes the licence region into it ("26.0.0 NOR
    // FULL") — so it is blanked; `generateHeader` fills an empty slot with
    // its own default rather than emitting '', which is equally non-leaking.
    expect(out!.preprocessorVersion).toBe('ifc-lite');
    expect(out!.originatingSystem).not.toBe('Source Originating System');
    expect(out!.originatingSystem).toBe('ifc-lite');
  });

  it('keeps the source originating_system when scrubOwnerHistory is false', async () => {
    const { result } = await runFullExport({ scrubOwnerHistory: false, guidRandom: seededRandom(7) });
    expect(parseSourceHeader(result.content)!.originatingSystem).toBe('Source Originating System');
  });

  it('blanks header FILE_DESCRIPTION instead of carrying the source items verbatim', async () => {
    // Same fixture, only the header's FILE_DESCRIPTION swapped for one
    // carrying identifying free text — the shape an authoring tool's
    // "Comment" field actually takes (project/client name, a contact
    // address), same class of signal as the author/organization/
    // authorization fields the sibling test above already proves blanked.
    const identifyingDescriptionModel = FIXTURE_MODEL.replace(
      "FILE_DESCRIPTION((''),'2;1');",
      "FILE_DESCRIPTION(('ViewDefinition [CoordinationView]',"
        + "'Comment [Property of Umbriel Nyx, contact nyx.umbriel@example-fictitious.test]'),'2;1');",
    );
    const store = await parse(identifyingDescriptionModel);
    const result = exportAnonymizedSubset(store, FULL_INCLUDED_IDS, { guidRandom: seededRandom(7) });
    const out = parseSourceHeader(result.content);
    expect(out).not.toBeNull();
    const description = out!.description.join(' ');
    expect(description).not.toContain('Umbriel Nyx');
    expect(description).not.toContain('nyx.umbriel@example-fictitious.test');
  });

  it('is deterministic and byte-identical across two independent runs with the same seed', async () => {
    const opts: AnonymizeOptions = { guidRandom: seededRandom(42), timeStamp: '2024-01-01T00:00:00' };
    const storeA = await parse(FIXTURE_MODEL);
    const contentA = decode(exportAnonymizedSubset(storeA, FULL_INCLUDED_IDS, opts).content);

    const storeB = await parse(FIXTURE_MODEL);
    const contentB = decode(exportAnonymizedSubset(storeB, FULL_INCLUDED_IDS, {
      guidRandom: seededRandom(42),
      timeStamp: '2024-01-01T00:00:00',
    }).content);

    expect(contentA).toBe(contentB);
  });
});

describe('exportAnonymizedSubset — type-owned property sets (IfcTypeObject.HasPropertySets)', () => {
  it('clears HasPropertySets to $ by default', async () => {
    const store = await parse(FIXTURE_MODEL);
    const result = exportAnonymizedSubset(store, new Set([1, 10]), { guidRandom: seededRandom(8) });
    const content = decode(result.content);
    expect(lineArgs(content, 10)[HAS_PROPERTY_SETS_SLOT]).toBe('$');
  });

  it('keeps the original HasPropertySets list when keepPropertySets is true', async () => {
    const store = await parse(FIXTURE_MODEL);
    // #11 (the wall type's own pset) must be included too, or "keep the
    // list" would keep a now-dangling reference — a real caller asking to
    // keep psets includes them in `includedIds` for the same reason.
    const result = exportAnonymizedSubset(store, new Set([1, 10, 11]), {
      keepPropertySets: true,
      guidRandom: seededRandom(8),
    });
    const content = decode(result.content);
    expect(lineArgs(content, 10)[HAS_PROPERTY_SETS_SLOT]).toBe('(#11)');
    expect(findDanglingRefs(content)).toEqual([]);
  });
});

describe('exportAnonymizedSubset — occurrence-owned property sets reaching includedIds directly (#3351 item 2, SDK path)', () => {
  // #13 (Pset_WallCommon) and #89 (the IfcRelDefinesByProperties naming it)
  // land in `includedIds` here the way a direct SDK caller would produce
  // them — e.g. `collectRelatedEntities(store, seeds, { IfcRelDefinesByProperties: true })`
  // adds exactly the pset id and its relationship id, never the individual
  // property entities (#14/#15 reach the export only through #13's own
  // `HasProperties` forward closure, same as any other non-root entity) —
  // NOT through the viewer's coupled toggles or the CLI's `--keep-psets`,
  // which is exactly the gap #3361 left open: it only fixed the two UI
  // entry points, not this orchestrator.
  const includedWithPset = new Set([1, 6, 13, 89]);

  it('excludes the property set entirely by default, including the identifying value it carried', async () => {
    const store = await parse(FIXTURE_MODEL);
    const result = exportAnonymizedSubset(store, includedWithPset, { guidRandom: seededRandom(11) });
    const content = decode(result.content);

    // The identifying VALUE (not a Name/Tag field, and not scrubbed by any
    // pseudonymization pass — see `applyScrub`'s own doc on why values are
    // deliberately left alone) must not survive at all: this only holds if
    // the pset was excluded, not merely name-scrubbed.
    expect(content).not.toContain('jane.doe@acme-corp.example');
    expect(content).not.toContain('IFCPROPERTYSET');
    expect(content).not.toContain('IFCRELDEFINESBYPROPERTIES');
    expect(findDanglingRefs(content)).toEqual([]);
  });

  it('reports the excluded property set ids distinctly, not just a silent drop', async () => {
    const store = await parse(FIXTURE_MODEL);
    const result = exportAnonymizedSubset(store, includedWithPset, { guidRandom: seededRandom(11) });

    expect(result.stats.droppedPropertySetIds).toEqual([13]);
    // The relationship that named ONLY the dropped pset (a single-valued,
    // mandatory reference) is pruned too, and reported through the existing
    // `prunedRelationshipIds` channel — the same one #3361 already added,
    // not a second parallel one.
    expect(result.stats.prunedRelationshipIds).toContain(89);
  });

  it('keeps the property set, values included, when keepPropertySets is true', async () => {
    const store = await parse(FIXTURE_MODEL);
    const result = exportAnonymizedSubset(store, includedWithPset, {
      keepPropertySets: true,
      guidRandom: seededRandom(11),
    });
    const content = decode(result.content);

    expect(result.stats.droppedPropertySetIds).toEqual([]);
    expect(content).toContain('jane.doe@acme-corp.example');
    expect(findDanglingRefs(content)).toEqual([]);
  });
});

describe('exportAnonymizedSubset — IfcPropertyReferenceValue into an excluded target (#3439)', () => {
  it('nulls a directly included property reference rather than emitting a dangling reference', async () => {
    const store = await parse(FIXTURE_MODEL);
    const result = exportAnonymizedSubset(store, new Set([1, 3, 95, 96]), {
      keepPropertySets: true,
      guidRandom: seededRandom(13),
    });
    const content = decode(result.content);

    expect(findDanglingRefs(content)).toEqual([]);
    expect(content).not.toContain('99 Imaginary Boulevard');
    expect(lineArgs(content, 96)[3]).toBe('$');
    expect(result.stats.droppedPropertyReferenceIds).toEqual([96]);
  });

  it('nulls a property value reached through an included defining relationship and property set', async () => {
    const store = await parse(FIXTURE_MODEL);
    const result = exportAnonymizedSubset(store, new Set([1, 3, 6, 95, 97]), {
      keepPropertySets: true,
      guidRandom: seededRandom(16),
    });
    const content = decode(result.content);

    // #96 is deliberately not a caller seed. The exporter reaches it through
    // #97 -> #95, so sanitization must run over the forward closure too.
    expect(content).toContain('#96=IFCPROPERTYREFERENCEVALUE');
    expect(findDanglingRefs(content)).toEqual([]);
    expect(lineArgs(content, 96)[3]).toBe('$');
    expect(result.stats.droppedPropertyReferenceIds).toEqual([96]);
  });

  it('leaves a property reference intact when the target is legitimately included', async () => {
    const store = await parse(FIXTURE_MODEL);
    const result = exportAnonymizedSubset(store, new Set([1, 3, 95, 96]), {
      keepPropertySets: true,
      removeGeoreferencing: false,
      guidRandom: seededRandom(15),
    });
    const content = decode(result.content);

    expect(findDanglingRefs(content)).toEqual([]);
    expect(lineArgs(content, 96)[3]).toBe('#51');
    expect(result.stats.droppedPropertyReferenceIds).toEqual([]);
  });
});

describe('exportAnonymizedSubset — relationship list trimming (partial exclusion) vs relationship pruning (total exclusion)', () => {
  it('trims an excluded member out of a SET/LIST relationship attribute rather than dropping the whole relationship', async () => {
    const store = await parse(FIXTURE_MODEL);
    // Wall B (#7) is deliberately NOT included: #89's RelatedObjects=(#6,#7)
    // still has a survivor (#6), so it is never pruned — the emitted LIST
    // just loses the excluded member, the existing (unrelated to this
    // feature) `filterHiddenRefsFromRelationshipLine` behaviour.
    // `keepPropertySets: true` keeps #13 (#89's RelatingPropertyDefinition,
    // a single-valued reference) in the subset: this test is about SET/LIST
    // trimming on RelatedObjects, not about the pset-drop behaviour covered
    // in "property sets reaching includedIds directly" below, and without
    // it #13 would itself be excluded by default, pruning #89 entirely.
    const result = exportAnonymizedSubset(store, new Set([1, 6, 13, 89]), {
      keepPropertySets: true,
      guidRandom: seededRandom(9),
    });
    const content = decode(result.content);

    expect(result.stats.prunedRelationshipIds).not.toContain(89);
    // RelatedObjects (index 4) trimmed to just the survivor; a plain
    // substring check would false-positive on "#7" inside "#74" (OwnerHistory).
    expect(lineArgs(content, 89)[4]).toBe('(#6)');
    expect(findDanglingRefs(content)).toEqual([]);
  });

  it('prunes a relationship whose mandatory single-valued reference is excluded, and reports it without the exporter\'s own "withheld" warning', async () => {
    const store = await parse(FIXTURE_MODEL);
    // Wall A (#6) and #80 (IfcRelVoidsElement, host->opening) are included;
    // the opening (#8) it names is deliberately NOT — its RelatedOpeningElement
    // has no survivor, so `exportAnonymizedSubset` removes #80 from the root
    // set BEFORE the exporter's own closure ever sees it, rather than letting
    // it be discovered mid-export and withheld.
    const result = exportAnonymizedSubset(store, new Set([1, 6, 80]), { guidRandom: seededRandom(10) });
    const content = decode(result.content);

    expect(result.stats.prunedRelationshipIds).toContain(80);
    expect(content).not.toContain('IFCRELVOIDSELEMENT');
    expect(content).not.toContain('IFCOPENINGELEMENT');
    expect(result.stats.warnings.some((w) => w.includes('withheld from the export'))).toBe(false);
    expect(findDanglingRefs(content)).toEqual([]);
  });
});

describe('exportAnonymizedSubset — unsupported root placement kind', () => {
  it('warns on an IfcGridPlacement root and leaves it untouched', async () => {
    const store = await parse(FIXTURE_MODEL);
    const result = exportAnonymizedSubset(store, new Set([1, 16]), { guidRandom: seededRandom(11) });
    const content = decode(result.content);

    expect(result.stats.warnings.some((w) => w.includes('IFCGRIDPLACEMENT'))).toBe(true);
    expect(content).toContain('#55=IFCGRIDPLACEMENT($,$,$);');
    expect(lineArgs(content, 16)[5]).toBe('#55'); // ObjectPlacement, unchanged
  });
});

/**
 * Regression fixture for the review blocker: unlike {@link FIXTURE_MODEL},
 * whose building deliberately SHARES the site's root point (#22) via its own
 * untouched child placement — proving the shared-point case must survive —
 * this fixture has no such sharer. Once the site's root placement is zeroed
 * (a clone-and-repoint, never a rewrite), nothing left in the included
 * subset references the ORIGINAL axis or point, so a correct export must
 * drop them entirely rather than leave them as an orphaned line still
 * carrying the real, un-anonymized coordinate.
 */
const FIXTURE_ISOLATED_PLACEMENT = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('anonymize-export-isolated-placement.ifc','2020-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('${guid(1)}',$,'Project Isolated',$,$,$,$,$,$);
#20=IFCLOCALPLACEMENT($,#21);
#21=IFCAXIS2PLACEMENT3D(#22,$,#23);
#22=IFCCARTESIANPOINT((1000.,2000.,30.));
#23=IFCDIRECTION((0.7071067811865476,0.7071067811865475,0.));
#2=IFCSITE('${guid(2)}',$,'Site Isolated',$,$,#20,$,$,.ELEMENT.,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;`;

describe('exportAnonymizedSubset — coordinate leak regression (review blocker)', () => {
  it('removes the original root axis and its coordinate entirely once nothing else references them', async () => {
    const store = await parse(FIXTURE_ISOLATED_PLACEMENT);
    const result = exportAnonymizedSubset(store, new Set([1, 2]), { guidRandom: seededRandom(12) });
    const content = decode(result.content);

    expect(content).not.toMatch(/^#21=/m);
    expect(content).not.toMatch(/^#22=/m);
    expect(content).not.toContain('1000.,2000.,30.');
    expect(findDanglingRefs(content)).toEqual([]);
  });
});

describe('exportAnonymizedSubset — precondition', () => {
  it('throws when the store has no source bytes to export from', async () => {
    const store = await parse(FIXTURE_MODEL);
    const sourcelessStore: IfcDataStore = { ...store, source: EMPTY_SOURCE_BYTES };
    expect(() => exportAnonymizedSubset(sourcelessStore, new Set([1]))).toThrow(/no source bytes/);
  });
});

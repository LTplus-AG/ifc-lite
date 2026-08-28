/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `anonymize-placement.ts` (#2934, the "anonymized isolated export" feature,
 * plan A4): root `IfcLocalPlacement` translation zeroing, clone-never-rewrite.
 *
 * Real fixture throughout (`new IfcParser().parseColumnar`), per this repo's
 * "assert behaviour through a real fixture" rule — never a mock store or a
 * source-text assertion of the module's own logic. Assertions read the
 * FINAL, RE-EXPORTED STEP text (via `StepExporter` + `subsetEntityIds`), not
 * the private overlay's internal state, so a mutation that never reaches the
 * file would still fail these tests.
 */

import { describe, expect, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from './step-exporter.js';
import { getEffectiveEntityIndex } from './effective-index.js';
import { applyPlacementAnonymization } from './anonymize-placement.js';
import { splitTopLevelArgs } from './step-argument-parser.js';

const enc = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer;
const decode = (b: Uint8Array): string => new TextDecoder().decode(b);

async function parse(model: string): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(enc(model));
}

/** 22-char synthetic GlobalId, deterministic and unique per `n`. */
const guid = (n: number): string => `0GUID${String(n).padStart(17, '0')}`;

/** Every `#N` referenced in the output that has no `#N=` defining line. */
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

/**
 * Site #2's root placement chain: #20 = IfcLocalPlacement (`PlacementRelTo =
 * $`, the root) → #21 = IfcAxis2Placement3D(Location=#22, Axis=$,
 * RefDirection=#23) → #22 = IfcCartesianPoint at a non-zero, non-synthetic
 * translation. #23 is a non-trivial `IfcDirection` — the rotation this
 * feature must KEEP.
 *
 * Building #3's placement #30 is a CHILD of the same root (`PlacementRelTo =
 * #20`) whose own axis #31 references the SAME point #22 as the root — this
 * is deliberate: #22 must survive byte-identical in the output (clone, never
 * rewrite), reached only through the untouched child placement #30/#31, while
 * the root #20 is repointed at a freshly cloned zero.
 *
 * Wall #6 sits on an `IfcGridPlacement` (#50) instead of a local placement —
 * a kind this export cannot safely zero.
 *
 * #7/#8/#9 (`IfcGeometricRepresentationContext`) sit at the origin already, so
 * the WorldCoordinateSystem zeroing pass has nothing to do here — it's
 * exercised implicitly (no error, no spurious clone) rather than the
 * material subject of these tests.
 */
const FIXTURE = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('placement-fixture.ifc','2024-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('${guid(1)}',$,'Project',$,$,$,$,$,$);
#7=IFCCARTESIANPOINT((0.,0.,0.));
#8=IFCAXIS2PLACEMENT3D(#7,$,$);
#9=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#8,$);
#20=IFCLOCALPLACEMENT($,#21);
#21=IFCAXIS2PLACEMENT3D(#22,$,#23);
#22=IFCCARTESIANPOINT((1000.,2000.,30.));
#23=IFCDIRECTION((0.7071067811865476,0.7071067811865475,0.));
#2=IFCSITE('${guid(2)}',$,'Site',$,$,#20,$,$,.ELEMENT.,$,$,$,$,$);
#30=IFCLOCALPLACEMENT(#20,#31);
#31=IFCAXIS2PLACEMENT3D(#22,$,$);
#3=IFCBUILDING('${guid(3)}',$,'Building',$,$,#30,$,$,.ELEMENT.,$,$,$);
#50=IFCGRIDPLACEMENT($,$,$);
#6=IFCWALL('${guid(6)}',$,'Wall G',$,$,#50,$,$);
ENDSEC;
END-ISO-10303-21;`;

/**
 * Regression fixture for the review blocker: the site's root placement chain
 * (#20/#21/#22/#23) is the SAME shape as {@link FIXTURE}'s, but the building
 * (#3) has NO placement of its own (`ObjectPlacement = $`) — nothing else in
 * the included subset references #21 or #22 once the root is repointed at a
 * clone, so a correct export must drop BOTH entirely, not merely stop naming
 * them from #20.
 */
const FIXTURE_ISOLATED = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('placement-fixture-isolated.ifc','2024-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('${guid(1)}',$,'Project',$,$,$,$,$,$);
#20=IFCLOCALPLACEMENT($,#21);
#21=IFCAXIS2PLACEMENT3D(#22,$,#23);
#22=IFCCARTESIANPOINT((1000.,2000.,30.));
#23=IFCDIRECTION((0.7071067811865476,0.7071067811865475,0.));
#2=IFCSITE('${guid(2)}',$,'Site',$,$,#20,$,$,.ELEMENT.,$,$,$,$,$);
#3=IFCBUILDING('${guid(3)}',$,'Building',$,$,$,$,$,.ELEMENT.,$,$,$);
ENDSEC;
END-ISO-10303-21;`;

/**
 * Regression fixture for the review blocker: five `IfcSite` slots
 * (`RefLatitude`/`RefLongitude`/`RefElevation`/`LandTitleNumber`/
 * `SiteAddress`) and `IfcBuilding.BuildingAddress` are OPTIONAL but not all
 * STRING-typed — `RefLatitude`/`RefLongitude` are `IfcCompoundPlaneAngleMeasure`
 * (a LIST OF INTEGER), `RefElevation` is a REAL, and the two addresses are
 * entity references — so blanking any of them with an empty STEP string
 * (`''`) rather than `$` would corrupt the record's schema shape and break a
 * strict re-parse. Every slot gets a REAL, non-synthetic value here (never
 * `$` to start with, unlike {@link FIXTURE}) so the assertions below prove
 * the blank came out right rather than passing vacuously.
 */
const FIXTURE_SITE_ATTRIBUTES = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('placement-fixture-site-attributes.ifc','2024-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('${guid(1)}',$,'Project',$,$,$,$,$,$);
#24=IFCPOSTALADDRESS($,$,$,$,('1 Real Street'),$,'Real Town','Real Region','12345','Real Country');
#25=IFCPOSTALADDRESS($,$,$,$,('2 Real Avenue'),$,'Real Town','Real Region','12345','Real Country');
#2=IFCSITE('${guid(2)}',$,'Site',$,$,$,$,$,.ELEMENT.,(47,22,15,0),(8,32,0,0),430.5,'LT-12345',#24);
#3=IFCBUILDING('${guid(3)}',$,'Building',$,$,$,$,$,.ELEMENT.,$,$,#25);
ENDSEC;
END-ISO-10303-21;`;

/** Anonymize the fixture in-place on a private overlay, then re-export the
 *  same `includedIds` subset so the test reads what the FILE actually says. */
async function anonymizeAndExport() {
  const store = await parse(FIXTURE);
  const view = new MutablePropertyView(null, 'anonymize');
  const editor = new StoreEditor(store, view);
  const index = getEffectiveEntityIndex(store, view, true);
  const includedIds = new Set([1, 2, 3, 6]);

  const result = applyPlacementAnonymization(store, index, includedIds, editor, view);

  const exported = new StepExporter(store, view).export({
    schema: store.schemaVersion,
    subsetEntityIds: includedIds,
    applyMutations: true,
  });

  return { result, content: decode(exported.content) };
}

describe('applyPlacementAnonymization (anonymized isolated export, #2934)', () => {
  it('zeroes the root placement translation and reports it', async () => {
    const { result, content } = await anonymizeAndExport();

    expect(result.zeroedPlacements).toHaveLength(1);
    expect(result.zeroedPlacements[0]).toEqual({ expressId: 20, translation: [1000, 2000, 30] });

    // #20 no longer names #21 (the original axis) — it was repointed at a
    // freshly cloned axis, never rewritten in place.
    const rootLine = content.match(/^#20=IFCLOCALPLACEMENT\(([^)]*)\);$/m);
    expect(rootLine).not.toBeNull();
    expect(rootLine![1]).not.toContain('#21');

    const newAxisId = +rootLine![1].split(',')[1].replace('#', '');
    const newAxisLine = content.match(new RegExp(`^#${newAxisId}=IFCAXIS2PLACEMENT3D\\(([^)]*)\\);$`, 'm'));
    expect(newAxisLine).not.toBeNull();
    const newPointId = +newAxisLine![1].split(',')[0].replace('#', '');
    expect(content).toContain(`#${newPointId}=IFCCARTESIANPOINT((0.,0.,0.));`);

    expect(findDanglingRefs(content)).toEqual([]);
  });

  it('keeps RefDirection — the rotation — on the cloned axis', async () => {
    const { content } = await anonymizeAndExport();

    const rootLine = content.match(/^#20=IFCLOCALPLACEMENT\(([^)]*)\);$/m)!;
    const newAxisId = rootLine[1].split(',')[1];
    const newAxisLine = content.match(new RegExp(`^${newAxisId}=IFCAXIS2PLACEMENT3D\\(([^)]*)\\);$`, 'm'))!;

    // Axis=$ and RefDirection=#23 carried over verbatim from the original #21.
    const [, axisTok, refDirTok] = newAxisLine[1].split(',');
    expect(axisTok).toBe('$');
    expect(refDirTok).toBe('#23');
    expect(content).toContain('#23=IFCDIRECTION((0.7071067811865476,0.7071067811865475,0.));');
  });

  it('leaves the child placement chain (#30/#31) completely untouched', async () => {
    const { content } = await anonymizeAndExport();

    expect(content).toContain('#30=IFCLOCALPLACEMENT(#20,#31);');
    expect(content).toContain('#31=IFCAXIS2PLACEMENT3D(#22,$,$);');
  });

  it('does not rewrite a point shared with a non-root placement', async () => {
    const { content } = await anonymizeAndExport();

    // #22 is still #31's Location (the child axis, above) AND its own
    // original coordinates are untouched — the root's clone got a NEW point,
    // #22 itself was never edited.
    expect(content).toContain('#22=IFCCARTESIANPOINT((1000.,2000.,30.));');
  });

  it('warns on and leaves an IfcGridPlacement root untouched', async () => {
    const { result, content } = await anonymizeAndExport();

    expect(result.warnings.some((w) => w.includes('IFCGRIDPLACEMENT'))).toBe(true);
    expect(content).toContain('#50=IFCGRIDPLACEMENT($,$,$);');
    expect(content).toContain(`#6=IFCWALL('${guid(6)}',$,'Wall G',$,$,#50,$,$);`);
  });

  it('removes the original root axis and its coordinate entirely once nothing else references them (regression: coordinate leak, review blocker)', async () => {
    const store = await parse(FIXTURE_ISOLATED);
    const view = new MutablePropertyView(null, 'anonymize');
    const editor = new StoreEditor(store, view);
    const index = getEffectiveEntityIndex(store, view, true);
    const includedIds = new Set([1, 2, 3]);

    applyPlacementAnonymization(store, index, includedIds, editor, view);

    const exported = new StepExporter(store, view).export({
      schema: store.schemaVersion,
      subsetEntityIds: includedIds,
      applyMutations: true,
    });
    const content = decode(exported.content);

    // #20 is repointed at a fresh, zeroed clone (proven by the earlier tests
    // above); with nothing else in this fixture pointing at the ORIGINAL
    // axis (#21) or its real coordinate (#22), a correct export must drop
    // both — not merely stop naming them from #20 while leaving them as
    // orphaned, un-anonymized lines with the real coordinate in plaintext.
    expect(content).not.toMatch(/^#21=/m);
    expect(content).not.toMatch(/^#22=/m);
    expect(content).not.toContain('1000.,2000.,30.');
    expect(findDanglingRefs(content)).toEqual([]);
  });

  it('blanks non-string IfcSite/IfcBuilding attributes as $, never an empty STEP string (review blocker: schema requires a REAL, a LIST, or a reference, not text)', async () => {
    const store = await parse(FIXTURE_SITE_ATTRIBUTES);
    const view = new MutablePropertyView(null, 'anonymize');
    const editor = new StoreEditor(store, view);
    const index = getEffectiveEntityIndex(store, view, true);
    const includedIds = new Set([1, 2, 3]);

    applyPlacementAnonymization(store, index, includedIds, editor, view);

    const exported = new StepExporter(store, view).export({
      schema: store.schemaVersion,
      subsetEntityIds: includedIds,
      applyMutations: true,
    });
    const content = decode(exported.content);

    const siteLine = content.match(/^#2=IFCSITE\(([^;]*)\);$/m);
    expect(siteLine).not.toBeNull();
    const siteArgs = splitTopLevelArgs(siteLine![1]);
    // RefLatitude, RefLongitude, RefElevation, LandTitleNumber, SiteAddress
    // are IfcSite's last five positional slots.
    const [refLatitude, refLongitude, refElevation, landTitleNumber, siteAddress] = siteArgs.slice(-5);
    expect(refLatitude).toBe('$');
    expect(refLongitude).toBe('$');
    expect(refElevation).toBe('$');
    expect(landTitleNumber).toBe('$');
    expect(siteAddress).toBe('$');
    expect(siteArgs).not.toContain("''");

    const buildingLine = content.match(/^#3=IFCBUILDING\(([^;]*)\);$/m);
    expect(buildingLine).not.toBeNull();
    const buildingArgs = splitTopLevelArgs(buildingLine![1]);
    expect(buildingArgs.at(-1)).toBe('$'); // BuildingAddress
    expect(buildingArgs).not.toContain("''");

    // The original IfcPostalAddress records (#24, #25) are no longer
    // referenced by anything in the subset once SiteAddress/BuildingAddress
    // are nulled, so a correct export drops them entirely — proving the real
    // address data left the file, not merely that the site/building stopped
    // naming it.
    expect(content).not.toMatch(/^#24=/m);
    expect(content).not.toMatch(/^#25=/m);
    expect(content).not.toContain('1 Real Street');
    expect(content).not.toContain('2 Real Avenue');
    expect(findDanglingRefs(content)).toEqual([]);
  });
});

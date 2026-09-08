/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared inline-STEP fixture for the anonymized-export dialog's viewer
 * tests (#2934, "anonymized isolated export"). One real, parseable IFC4
 * model — project -> site -> building -> 2 storeys; Wall A (storey 1, host)
 * with an opening + window and an `IfcWallType`; Wall B (storey 2), sharing
 * a material with Wall A; Wall C (storey 2), structurally connected to Wall
 * B via `IfcRelConnectsPathElements` — reused (never asserted on as source
 * text) by every `.test.tsx` in this folder, per `AGENTS.md`'s "Writing
 * tests" recipe: `new IfcParser().parseColumnar(...)` over inline STEP, not
 * a hand-shaped store stub.
 *
 * Not itself a `.test.*` file, so it carries no tests of its own — it is
 * fixture support, imported by the files that do.
 */

import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';

/** 22-char synthetic GlobalId, deterministic and unique per `n`. */
export const guid = (n: number): string => `0GUID${String(n).padStart(17, '0')}`;

export const FIXTURE_PROJECT = 1;
export const FIXTURE_SITE = 2;
export const FIXTURE_BUILDING = 3;
export const FIXTURE_STOREY_1 = 4;
export const FIXTURE_STOREY_2 = 5;
export const FIXTURE_WALL_A = 6;
export const FIXTURE_WALL_B = 7;
export const FIXTURE_OPENING = 8;
export const FIXTURE_WINDOW = 9;
export const FIXTURE_WALL_TYPE = 10;
export const FIXTURE_WALL_C = 17;
export const FIXTURE_MATERIAL = 40;
export const FIXTURE_REL_ASSOCIATES_MATERIAL = 44;
export const FIXTURE_REL_VOIDS = 80;
export const FIXTURE_REL_FILLS = 81;
export const FIXTURE_REL_DEFINES_BY_TYPE = 82;
export const FIXTURE_REL_CONTAINED_1 = 83;
export const FIXTURE_REL_CONTAINED_2 = 84;
export const FIXTURE_REL_AGGREGATES_PROJECT_SITE = 85;
export const FIXTURE_REL_AGGREGATES_SITE_BUILDING = 86;
export const FIXTURE_REL_AGGREGATES_BUILDING_STOREYS = 87;
export const FIXTURE_REL_CONNECTS_B_C = 88;

/**
 * `Wall A -> Opening -> Window` (host/opening/filler), `Wall A -> WallType`,
 * `{Wall A, Wall B} -> Material`, `Wall B <-> Wall C` (connected path,
 * depth-gated), and the full spatial chain `Project -> Site -> Building ->
 * {Storey 1, Storey 2}` with Wall A in storey 1 and {Wall B, Wall C} in
 * storey 2. All names/tags are synthetic and unique, so a test can assert
 * their absence from an anonymized export without any risk of a false
 * negative against real project data.
 */
export const FIXTURE_MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('anonymized-export-fixture.ifc','2020-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#${FIXTURE_PROJECT}=IFCPROJECT('${guid(FIXTURE_PROJECT)}',$,'Project Fixture',$,$,$,$,$,$);
#${FIXTURE_SITE}=IFCSITE('${guid(FIXTURE_SITE)}',$,'Site Fixture',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);
#${FIXTURE_BUILDING}=IFCBUILDING('${guid(FIXTURE_BUILDING)}',$,'Building Fixture',$,$,$,$,$,.ELEMENT.,$,$,$);
#${FIXTURE_STOREY_1}=IFCBUILDINGSTOREY('${guid(FIXTURE_STOREY_1)}',$,'Storey One',$,$,$,$,$,$,0.);
#${FIXTURE_STOREY_2}=IFCBUILDINGSTOREY('${guid(FIXTURE_STOREY_2)}',$,'Storey Two',$,$,$,$,$,$,3.);
#${FIXTURE_WALL_A}=IFCWALL('${guid(FIXTURE_WALL_A)}',$,'Wall A',$,$,$,$,'TAG-A');
#${FIXTURE_WALL_B}=IFCWALL('${guid(FIXTURE_WALL_B)}',$,'Wall B',$,$,$,$,'TAG-B');
#${FIXTURE_WALL_C}=IFCWALL('${guid(FIXTURE_WALL_C)}',$,'Wall C',$,$,$,$,'TAG-C');
#${FIXTURE_OPENING}=IFCOPENINGELEMENT('${guid(FIXTURE_OPENING)}',$,'Opening A',$,$,$,$,$);
#${FIXTURE_WINDOW}=IFCWINDOW('${guid(FIXTURE_WINDOW)}',$,'Window A',$,$,$,$,'TAG-WIN',1.,1.);
#${FIXTURE_WALL_TYPE}=IFCWALLTYPE('${guid(FIXTURE_WALL_TYPE)}',$,'WallType Fixture',$,$,$,$,$,$,.NOTDEFINED.);
#${FIXTURE_MATERIAL}=IFCMATERIAL('Concrete Fixture');
#${FIXTURE_REL_ASSOCIATES_MATERIAL}=IFCRELASSOCIATESMATERIAL('${guid(FIXTURE_REL_ASSOCIATES_MATERIAL)}',$,$,$,(#${FIXTURE_WALL_A},#${FIXTURE_WALL_B}),#${FIXTURE_MATERIAL});
#${FIXTURE_REL_VOIDS}=IFCRELVOIDSELEMENT('${guid(FIXTURE_REL_VOIDS)}',$,$,$,#${FIXTURE_WALL_A},#${FIXTURE_OPENING});
#${FIXTURE_REL_FILLS}=IFCRELFILLSELEMENT('${guid(FIXTURE_REL_FILLS)}',$,$,$,#${FIXTURE_OPENING},#${FIXTURE_WINDOW});
#${FIXTURE_REL_DEFINES_BY_TYPE}=IFCRELDEFINESBYTYPE('${guid(FIXTURE_REL_DEFINES_BY_TYPE)}',$,$,$,(#${FIXTURE_WALL_A}),#${FIXTURE_WALL_TYPE});
#${FIXTURE_REL_CONTAINED_1}=IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid(FIXTURE_REL_CONTAINED_1)}',$,$,$,(#${FIXTURE_WALL_A}),#${FIXTURE_STOREY_1});
#${FIXTURE_REL_CONTAINED_2}=IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid(FIXTURE_REL_CONTAINED_2)}',$,$,$,(#${FIXTURE_WALL_B},#${FIXTURE_WALL_C}),#${FIXTURE_STOREY_2});
#${FIXTURE_REL_AGGREGATES_PROJECT_SITE}=IFCRELAGGREGATES('${guid(FIXTURE_REL_AGGREGATES_PROJECT_SITE)}',$,$,$,#${FIXTURE_PROJECT},(#${FIXTURE_SITE}));
#${FIXTURE_REL_AGGREGATES_SITE_BUILDING}=IFCRELAGGREGATES('${guid(FIXTURE_REL_AGGREGATES_SITE_BUILDING)}',$,$,$,#${FIXTURE_SITE},(#${FIXTURE_BUILDING}));
#${FIXTURE_REL_AGGREGATES_BUILDING_STOREYS}=IFCRELAGGREGATES('${guid(FIXTURE_REL_AGGREGATES_BUILDING_STOREYS)}',$,$,$,#${FIXTURE_BUILDING},(#${FIXTURE_STOREY_1},#${FIXTURE_STOREY_2}));
#${FIXTURE_REL_CONNECTS_B_C}=IFCRELCONNECTSPATHELEMENTS('${guid(FIXTURE_REL_CONNECTS_B_C)}',$,$,$,$,#${FIXTURE_WALL_B},#${FIXTURE_WALL_C},(),(),.ATSTART.,.ATEND.);
ENDSEC;
END-ISO-10303-21;
`;

/** Parse {@link FIXTURE_MODEL} through the real columnar parser. Memoized —
 *  every caller in one test file gets the SAME parsed store, matching how
 *  `measure-parity.test.tsx` shares one `parseMiniStore()`. */
let cached: Promise<IfcDataStore> | null = null;
export function parseFixtureModel(): Promise<IfcDataStore> {
  if (!cached) {
    const bytes = new TextEncoder().encode(FIXTURE_MODEL);
    cached = new IfcParser().parseColumnar(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
  }
  return cached;
}

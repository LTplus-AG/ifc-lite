/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Closes a P1 security finding filed against #2934 (the "anonymized
 * isolated export" feature): "spatial roots remain identifiable" — the
 * claim that a caller who selects a product WITHOUT explicitly including its
 * `IfcSite`/`IfcBuilding` ancestors could still get real georeferencing
 * (`RefLatitude`/`RefLongitude`/`RefElevation`/`LandTitleNumber`) or a real
 * `IfcPostalAddress` into the exported file, because the scrub loop in
 * `anonymize-placement.ts` only processes `includedIds` and an un-included
 * site was assumed to slip past it.
 *
 * Traced against the code, that path does not exist: `getSubsetEntityIds`
 * (`subset-roots.ts`) puts every `IFC_ROOT_TYPES` member NOT in `includedIds`
 * — `IfcSite` included — into `excludedIds`, which `applyExportClosure`
 * (`step-collection.ts`) feeds to `collectReferencedEntityIds` as a walk
 * blocklist (`reference-collector.ts`, the `excludeIds.has(referencedId)`
 * check ahead of every enqueue). `IFCSITE` is never in `INFRASTRUCTURE_TYPES`
 * (the only "always a root regardless of `includedIds`" set), so an
 * un-selected site is never force-included the way owner history or the
 * geometric context is.
 *
 * So there are exactly two reachable states for an `IfcSite`, and this file
 * proves both: caller didn't select it → absent, VALUES included nowhere in
 * the output (not just the `IFCSITE` token); caller DID select it → present,
 * but scrubbed by `anonymize-placement.ts`'s `blankSiteAndBuildingAddresses`.
 * The scrubbed-case assertions check for the ABSENCE of the original values
 * rather than for an exact blank token (`''` vs `$`), since which token a
 * blanked slot serializes as is a separate, unrelated concern from whether
 * the identifying data survived.
 */

import { describe, expect, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { exportAnonymizedSubset } from './anonymize-export.js';

const enc = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer;
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

async function parse(model: string): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(enc(model));
}

/** 22-char synthetic GlobalId, deterministic and unique per `n` — same
 *  convention `anonymize-export.test.ts` uses. */
const guid = (n: number): string => `0GUID${String(n).padStart(17, '0')}`;

/** Every `#N` referenced in the output that has no `#N=` defining line —
 *  same helper as `anonymize-export.test.ts`. */
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
 * `IfcSite` #2, deliberately given real-looking georeferencing and address
 * data: a compound-plane-angle `RefLatitude`/`RefLongitude`, a `RefElevation`,
 * a `LandTitleNumber`, and a `SiteAddress` pointing at an `IfcPostalAddress`
 * (#50). Every literal below was chosen to be numerically distinctive (not a
 * small integer likely to coincidentally match an expressId elsewhere in the
 * output), so a substring match on it in the exported file is meaningful.
 * The wall (#6) sits on its OWN placement (#30/#31/#32), independent of the
 * site's (#20/#21/#22), so zeroing one root placement can never be mistaken
 * for scrubbing the other.
 */
const FIXTURE_MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('subset-security-site-georef-fixture.ifc','2020-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#20=IFCLOCALPLACEMENT($,#21);
#21=IFCAXIS2PLACEMENT3D(#22,$,$);
#22=IFCCARTESIANPOINT((0.,0.,0.));
#30=IFCLOCALPLACEMENT($,#31);
#31=IFCAXIS2PLACEMENT3D(#32,$,$);
#32=IFCCARTESIANPOINT((5.,5.,5.));
#1=IFCPROJECT('${guid(1)}',$,'Project Confidential',$,$,$,$,$,$);
#2=IFCSITE('${guid(2)}',$,'Site Confidential',$,$,#20,$,$,.ELEMENT.,(51,30,45,823571),(-9,3,17,654321),271.828,'LAND-TITLE-SECRET-4471',#50);
#50=IFCPOSTALADDRESS($,$,$,$,('1 Secret Lane'),$,'Secret City','Secret Province','SEC-000','Secret Country');
#6=IFCWALL('${guid(6)}',$,'Wall Public',$,$,#30,$,'TAG-PUBLIC');
#85=IFCRELAGGREGATES('${guid(85)}',$,$,$,#1,(#2));
#83=IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid(83)}',$,$,$,(#6),#2);
ENDSEC;
END-ISO-10303-21;`;

/** Every string/number token that identifies the site's real-world location
 *  or land record — none of these may survive in the export under EITHER
 *  branch this file tests, whether or not the site itself is emitted. */
const SITE_IDENTIFYING_VALUES = [
  '823571', // RefLatitude's millionths-of-a-second component
  '654321', // RefLongitude's millionths-of-a-second component
  '271.828', // RefElevation
  'LAND-TITLE-SECRET-4471', // LandTitleNumber
  '1 Secret Lane', // IfcPostalAddress.AddressLines
  'Secret City', // IfcPostalAddress.Town
  'Secret Province', // IfcPostalAddress.Region
  'SEC-000', // IfcPostalAddress.PostalCode
  'Secret Country', // IfcPostalAddress.Country
];

describe('anonymized subset export — spatial root (IfcSite) security (P1 finding response)', () => {
  it('un-selected: selecting only a product (not its IfcSite) emits no IfcSite, no IfcPostalAddress, and none of the site\'s identifying values', async () => {
    const store = await parse(FIXTURE_MODEL);
    // Project + wall selected; the SITE (#2) and its address (#50) are
    // deliberately NOT in includedIds — this is the exact scenario the
    // finding described.
    const result = exportAnonymizedSubset(store, new Set([1, 6]));
    const content = decode(result.content);

    expect(content).not.toContain('IFCSITE');
    expect(content).not.toContain('IFCPOSTALADDRESS');
    for (const needle of SITE_IDENTIFYING_VALUES) {
      expect(content, `expected "${needle}" to be absent when the site was never selected`).not.toContain(needle);
    }
    expect(findDanglingRefs(content)).toEqual([]);
  });

  it('selected: explicitly including the IfcSite emits it, but scrubbed — none of its identifying values survive', async () => {
    const store = await parse(FIXTURE_MODEL);
    const result = exportAnonymizedSubset(store, new Set([1, 2]));
    const content = decode(result.content);

    // The site itself IS emitted this time (the part that distinguishes this
    // branch from the one above) …
    expect(content).toContain('IFCSITE');
    // … but scrubbed: its own IfcPostalAddress is gone (IDENTIFYING_TYPES is
    // excluded from a subset export regardless of includedIds — see
    // `subset-roots.ts`), and none of the real values it carried survive
    // anywhere in the output. Deliberately not asserting the blanked slots
    // equal any particular token ('' vs '$') — only that the VALUES are gone.
    expect(content).not.toContain('IFCPOSTALADDRESS');
    for (const needle of SITE_IDENTIFYING_VALUES) {
      expect(content, `expected "${needle}" to be scrubbed from the included, exported site`).not.toContain(needle);
    }
    expect(findDanglingRefs(content)).toEqual([]);
  });
});

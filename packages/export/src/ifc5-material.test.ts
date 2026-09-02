/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `buildMaterialAttribute` builds the `bsi::ifc::material` payload emitted by
 * {@link Ifc5Exporter} for an `IfcRelAssociatesMaterial` association. The
 * shape it must produce is defined by the vendored buildingSMART schema
 * (`packages/export/src/__fixtures__/schemas/ifc@v5a.ifcx`), which declares
 * `bsi::ifc::material` as an Object requiring both `code` and `uri` (neither
 * key is marked `optional`, the same convention `bsi::ifc::class` uses right
 * next to it in the same file — and `bsi::ifc::class` emits both).
 *
 * The real buildingSMART reference sample committed at
 * `apps/viewer/public/samples/hello-wall.ifcx` confirms this reading: every
 * `bsi::ifc::material` value it contains carries a `uri` resolving into
 * buildingSMART's own `midas-materials` identifier registry, e.g.
 * `https://identifier.buildingsmart.org/uri/fish/midas-materials/26/class/CONCRETE`.
 * So a registry for material identifiers exists — contrary to this file's own
 * prior comment, which said "a freeform IFC4 `IfcMaterial.Name` has no such
 * registry" and used that as the reason to omit `uri` outright.
 *
 * `buildMaterialAttribute` returned `{ code }` with no `uri` key at all,
 * which `validateValue` (the same helper `ifc5-exporter.test.ts` uses for
 * every other IFC5 attribute) flags as "Missing required key uri" against
 * the vendored schema.
 */

import { describe, expect, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { buildMaterialAttribute } from './ifc5-material.js';
import { ALL_OFFICIAL_SCHEMAS, validateValue } from './__fixtures__/ifc5-official-schemas.js';

const enc = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer;

async function parse(model: string): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(enc(model));
}

const guid = (n: number): string => `0GUID${String(n).padStart(17, '0')}`;

/** Wall #5 associated with material "Concrete" (#9) via `IfcRelAssociatesMaterial` #27. */
const FIXTURE_MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('ifc5-material-fixture.ifc','2024-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('${guid(1)}',$,'Project',$,$,$,$,$,$);
#5=IFCWALL('${guid(5)}',$,'Wall A',$,$,$,$,$);
#9=IFCMATERIAL('Concrete');
#27=IFCRELASSOCIATESMATERIAL('${guid(27)}',$,$,$,(#5),#9);
ENDSEC;
END-ISO-10303-21;`;

describe('buildMaterialAttribute — conformance to the vendored bsi::ifc::material schema', () => {
  it('emits a value that satisfies every required key of the official schema', async () => {
    const store = await parse(FIXTURE_MODEL);
    const attr = buildMaterialAttribute(store, 5);

    expect(attr).toBeDefined();
    expect(attr?.code).toBe('Concrete');

    const schema = ALL_OFFICIAL_SCHEMAS['bsi::ifc::material'];
    const errors = validateValue(attr, schema.value, 'bsi::ifc::material');
    expect(errors).toEqual([]);
  });

  // Control: an entity with no material association still yields `undefined`
  // — proves the fix does not fabricate a material out of nothing.
  it('control: returns undefined when the entity has no material association', async () => {
    const store = await parse(FIXTURE_MODEL);
    const attr = buildMaterialAttribute(store, 1);
    expect(attr).toBeUndefined();
  });
});

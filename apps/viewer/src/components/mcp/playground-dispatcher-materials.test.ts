/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The playground's own `makeIdsAccessor().getMaterials` (used by the
 * `ids_validate` tool) is a SEPARATE reimplementation from
 * `@ifc-lite/ids`'s `flattenMaterials` (packages/ids/src/bridge/materials.ts)
 * — a "two paths that must agree" case. The playground copy only ever
 * looked at `mat.layers` or the top-level `mat.name`, so an
 * `IfcMaterialConstituentSet` (or `IfcMaterialProfileSet` / `IfcMaterialList`)
 * association was invisible to IDS material requirements: the spec
 * false-failed even though the model genuinely carries the required
 * material.
 *
 * Fixture: an `IfcWall` associated (via `IfcRelAssociatesMaterial`) to an
 * `IfcMaterialConstituentSet` with no set-level name — only its one
 * constituent, whose underlying `IfcMaterial` is named 'Fireproofing'.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { dispatch, parsePlaygroundModel } from './playground-dispatcher.js';

function ifc4(body: string): string {
  return [
    'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('','',(''),(''),'','','');", "FILE_SCHEMA(('IFC4'));", 'ENDSEC;',
    'DATA;', body, 'ENDSEC;', 'END-ISO-10303-21;', '',
  ].join('\n');
}

const CONSTITUENT_SET_WALL = ifc4(`
#100=IFCWALL('0Wall0000000000000001',$,'Wall A',$,$,$,$,$,$);
#200=IFCMATERIAL('Fireproofing',$,$);
#210=IFCMATERIALCONSTITUENT($,$,#200,$,$);
#220=IFCMATERIALCONSTITUENTSET($,$,(#210));
#230=IFCRELASSOCIATESMATERIAL('0RelMat00000000000001',$,$,$,(#100),#220);
`);

const PLAIN_MATERIAL_WALL = ifc4(`
#100=IFCWALL('0Wall0000000000000002',$,'Wall B',$,$,$,$,$,$);
#200=IFCMATERIAL('Fireproofing',$,$);
#230=IFCRELASSOCIATESMATERIAL('0RelMat00000000000002',$,$,$,(#100),#200);
`);

function materialIdsXml(materialName: string): string {
  return `<ids xmlns="http://standards.buildingsmart.org/IDS">
  <info><title>Material check</title></info>
  <specifications>
    <specification name="Fireproofing required" ifcVersion="IFC4" minOccurs="1" maxOccurs="unbounded">
      <applicability>
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <material><value><simpleValue>${materialName}</simpleValue></value></material>
      </requirements>
    </specification>
  </specifications>
</ids>`;
}

async function runIdsValidate(ifc: string, materialName: string) {
  const model = await parsePlaygroundModel(
    new TextEncoder().encode(ifc).buffer as ArrayBuffer,
    'fixture.ifc',
  );
  const result = await dispatch(model, 'ids_validate', { ids_xml: materialIdsXml(materialName) });
  assert.equal(result.isError, false, `ids_validate should not error: ${result.text}`);
  const structured = result.structured as { summary: { passedSpecifications: number; totalSpecifications: number } };
  return structured.summary;
}

describe('playground ids_validate — material facet across variants', () => {
  it('CONTROL: a plain IfcMaterial association passes the material requirement', async () => {
    const summary = await runIdsValidate(PLAIN_MATERIAL_WALL, 'Fireproofing');
    assert.equal(summary.passedSpecifications, 1);
    assert.equal(summary.totalSpecifications, 1);
  });

  it('an IfcMaterialConstituentSet association passes the material requirement', async () => {
    const summary = await runIdsValidate(CONSTITUENT_SET_WALL, 'Fireproofing');
    assert.equal(
      summary.passedSpecifications,
      1,
      'the wall genuinely carries a Fireproofing constituent material — the spec must pass',
    );
    assert.equal(summary.totalSpecifications, 1);
  });
});

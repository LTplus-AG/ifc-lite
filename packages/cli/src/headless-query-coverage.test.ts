/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What an unfiltered `bim.query()` covers, and what `EntityData.type` reports,
 * against the real columnar parser rather than a mock.
 *
 * Both gaps were silent: the query returned a shorter list and every class
 * outside the curated `IfcTypeEnum` simply was not in it, and `type` answered
 * 'Unknown' for classes the product table does not index. Nothing distinguished
 * either from "the model does not contain that".
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createHeadlessContext } from './loader.js';

const MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2024',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('PROJ00000000000000000X',$,'Proj',$,$,$,$,(#20),#30);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#70= IFCWALL('WALL00000000000000000X',$,'A Wall',$,$,$,$,'tag',$);
#71= IFCAIRTERMINAL('AIRT00000000000000000X',$,'A Terminal',$,$,$,$,'tag',.DIFFUSER.);
#72= IFCDUCTFITTING('DUCT00000000000000000X',$,'A Fitting',$,$,$,$,'tag',.BEND.);
#73= IFCAIRTERMINALTYPE('AITY00000000000000000X',$,'A Terminal Type',$,$,$,$,$,$,.DIFFUSER.);
#100= IFCPROPERTYSINGLEVALUE('Reference',$,IFCIDENTIFIER('W-01'),$);
#102= IFCPROPERTYSET('PSET00000000000000000X',$,'Pset_WallCommon',$,(#100));
#103= IFCRELDEFINESBYPROPERTIES('RELP00000000000000000X',$,$,$,(#70),#102);
ENDSEC;
END-ISO-10303-21;
`;

async function loadModel() {
  const dir = await mkdtemp(join(tmpdir(), 'ifc-lite-headless-query-'));
  const path = join(dir, 'model.ifc');
  await writeFile(path, MODEL, 'utf-8');
  return (await createHeadlessContext(path)).bim;
}

describe('unfiltered bim.query()', () => {
  it('includes product classes the curated IfcTypeEnum omits', async () => {
    const bim = await loadModel();
    const types = bim.query().toArray().map(e => e.type);

    // IfcAirTerminal and IfcDuctFitting both resolve to IfcTypeEnum.Unknown,
    // and were dropped entirely before the gate moved to the inheritance chain.
    expect(types).toContain('IfcAirTerminal');
    expect(types).toContain('IfcDuctFitting');
    expect(types).toContain('IfcWall');
    expect(types).toContain('IfcProject');
  });

  it('still excludes type objects, relationships, property sets and geometry', async () => {
    const bim = await loadModel();
    const types = new Set(bim.query().toArray().map(e => e.type));

    expect(types.has('IfcAirTerminalType')).toBe(false);
    expect(types.has('IfcRelDefinesByProperties')).toBe(false);
    expect(types.has('IfcPropertySet')).toBe(false);
    expect(types.has('IfcCartesianPoint')).toBe(false);
    expect(types.has('IfcAxis2Placement3D')).toBe(false);
  });

  it('never reports a class as Unknown', async () => {
    const bim = await loadModel();
    expect(bim.query().toArray().filter(e => e.type === 'Unknown')).toEqual([]);
  });
});

describe('EntityData.type for classes the product table does not index', () => {
  it('names a property set instead of answering Unknown', async () => {
    const bim = await loadModel();
    const pset = bim.query().byType('IfcPropertySet').first();
    expect(pset?.type).toBe('IfcPropertySet');
  });

  it('names a relationship instead of answering Unknown', async () => {
    const bim = await loadModel();
    const rel = bim.query().byType('IfcRelDefinesByProperties').first();
    expect(rel?.type).toBe('IfcRelDefinesByProperties');
  });
});

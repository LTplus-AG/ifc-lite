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

import { describe, expect, it } from 'vitest';
import { ifcFile, loadInlineModel } from './headless-test-helpers.js';

const MODEL = ifcFile(`#70= IFCWALL('WALL00000000000000000X',$,'A Wall',$,$,$,$,'tag',$);
#71= IFCAIRTERMINAL('AIRT00000000000000000X',$,'A Terminal',$,$,$,$,'tag',.DIFFUSER.);
#72= IFCDUCTFITTING('DUCT00000000000000000X',$,'A Fitting',$,$,$,$,'tag',.BEND.);
#73= IFCAIRTERMINALTYPE('AITY00000000000000000X',$,'A Terminal Type',$,$,$,$,$,$,.DIFFUSER.);
#100= IFCPROPERTYSINGLEVALUE('Reference',$,IFCIDENTIFIER('W-01'),$);
#102= IFCPROPERTYSET('PSET00000000000000000X',$,'Pset_WallCommon',$,(#100));
#103= IFCRELDEFINESBYPROPERTIES('RELP00000000000000000X',$,$,$,(#70),#102);`);

const loadModel = () => loadInlineModel(MODEL, 'query');

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

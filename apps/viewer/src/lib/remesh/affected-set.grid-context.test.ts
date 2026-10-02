/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { it } from 'node:test';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { remeshContextRoots } from '@ifc-lite/export';
import { expandAffectedSet } from './affected-set';

// Parsed relationships are the dependency oracle, not a mocked export helper.
const IFC = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0000000000000000000001',$,'P',$,$,$,$,$,$);
#100=IFCWALL('0000000000000000000100',$,'W',$,$,$,$,$,$);
#110=IFCOPENINGELEMENT('0000000000000000000110',$,'O',$,$,$,$,$,.OPENING.);
#116=IFCRELVOIDSELEMENT('0000000000000000000116',$,$,$,#100,#110);
#120=IFCWINDOW('0000000000000000000120',$,'Win',$,$,$,$,$,$,$,$,$,$);
#122=IFCRELFILLSELEMENT('0000000000000000000122',$,$,$,#110,#120);
#200=IFCGRID('0000000000000000000200',$,'Grid',$,$,$,$,(#201),(#202),$,.RECTANGULAR.);
#201=IFCGRIDAXIS('A',#211,.T.);
#202=IFCGRIDAXIS('1',#214,.T.);
#203=IFCGRIDPLACEMENT(#204,$);
#204=IFCVIRTUALGRIDINTERSECTION((#201,#202),(0.,0.));
#205=IFCCOLUMN('0000000000000000000205',$,'Bound',$,$,#203,$,$,$);
#210=IFCCARTESIANPOINT((0.,0.,0.));
#211=IFCPOLYLINE((#210,#212));
#212=IFCCARTESIANPOINT((1.,0.,0.));
#213=IFCCARTESIANPOINT((0.,1.,0.));
#214=IFCPOLYLINE((#210,#213));
ENDSEC;
END-ISO-10303-21;`;

class ObservedView extends MutablePropertyView {
  enumerations = 0;
  override getNewEntities() {
    this.enumerations++;
    return super.getNewEntities();
  }
}

async function fixture() {
  const bytes = new TextEncoder().encode(IFC);
  const store = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
  const view = new ObservedView(null, 'm');
  return { store, view, editor: new StoreEditor(store, view) };
}

const sorted = (ids: Set<number>) => [...ids].sort((a, b) => a - b);
const guid = (n: number) => String(9000 + n).padStart(22, '0');

for (const target of ['source', 'overlay'] as const) {
  it(`#6592 ordinary ${target} remesh retains void/fill dependencies without extra full-overlay enumeration`, async () => {
    const { store, view, editor } = await fixture();
    const wall = target === 'source' ? 100 : editor.addEntity('IfcWall', [guid(1), null, 'New', null, null, null, null, null, null]).expressId;
    const opening = editor.addEntity('IfcOpeningElement', [guid(2), null, 'New opening', null, null, null, null, null, '.OPENING.']).expressId;
    const window = editor.addEntity('IfcWindow', [guid(3), null, 'New window', null, null, null, null, null, null, null, null, null, null]).expressId;
    editor.addEntity('IfcRelVoidsElement', [guid(4), null, null, null, `#${wall}`, `#${opening}`]);
    editor.addEntity('IfcRelFillsElement', [guid(5), null, null, null, `#${opening}`, `#${window}`]);
    for (let i = 0; i < 64; i++) editor.addEntity('IfcCartesianPoint', [[i, 0, 0]]);

    view.enumerations = 0;
    remeshContextRoots(store, view, new Set([wall]));
    const canonicalContextEnumerations = view.enumerations;
    view.enumerations = 0;
    // A one-shot input must survive target classification and dependency expansion.
    function* targets() { yield wall; }
    const actual = expandAffectedSet(store, view, targets(), 'hostsChanged');
    const expected = [wall, opening, window, ...(target === 'source' ? [110, 120] : [])].sort((a, b) => a - b);
    assert.deepEqual(sorted(actual), expected);
    assert.equal(view.enumerations, canonicalContextEnumerations,
      'ordinary edits must not enumerate queued creations again for an unrelated grid index');
  });
}

for (const target of ['source', 'overlay', 'retyped-overlay'] as const) {
  it(`#6592 ${target} grid still includes bound products and their local-placement children`, async () => {
    const { store, view, editor } = await fixture();
    let grid = 200, placement = 203, column = 205;
    if (target !== 'source') {
      const first = editor.addEntity('IfcGridAxis', ['B', '#211', '.T.']).expressId;
      const second = editor.addEntity('IfcGridAxis', ['2', '#214', '.T.']).expressId;
      grid = editor.addEntity(target === 'overlay' ? 'IfcGrid' : 'IfcBuildingElementProxy', target === 'overlay'
        ? [guid(6), null, 'New grid', null, null, null, null, [`#${first}`], [`#${second}`], null, '.RECTANGULAR.']
        : [guid(6), null, 'Retyped grid', null, null, null, null, null, '.NOTDEFINED.']).expressId;
      if (target === 'retyped-overlay') {
        assert.ok(editor.setEntityType(grid, 'IfcGrid'));
        // Retypes preserve common EXPRESS attributes; supply the new grid rows explicitly.
        editor.setPositionalAttribute(grid, 7, [`#${first}`]);
        editor.setPositionalAttribute(grid, 8, [`#${second}`]);
        editor.setPositionalAttribute(grid, 9, null);
        editor.setPositionalAttribute(grid, 10, '.RECTANGULAR.');
      }
      const crossing = editor.addEntity('IfcVirtualGridIntersection', [[`#${first}`, `#${second}`], [0, 0]]).expressId;
      placement = editor.addEntity('IfcGridPlacement', [`#${crossing}`, null]).expressId;
      column = editor.addEntity('IfcColumn', [guid(7), null, 'Bound', null, null, `#${placement}`, null, null, null]).expressId;
    }
    const axis = editor.addEntity('IfcAxis2Placement3D', ['#210', null, null]).expressId;
    const local = editor.addEntity('IfcLocalPlacement', [`#${placement}`, `#${axis}`]).expressId;
    const child = editor.addEntity('IfcColumn', [guid(8), null, 'Child', null, null, `#${local}`, null, null, null]).expressId;
    assert.deepEqual(sorted(expandAffectedSet(store, view, [grid], 'hostsChanged')), [grid, column, child].sort((a, b) => a - b));
  });
}

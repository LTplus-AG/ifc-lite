/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readStep } from './step.mjs';
import { classificationOf, inheritedFireRating, layerUsage, scheduleTotal, typeOf, assignedLayerMaterials } from './measured-oracles.mjs';
const fixture = `DATA;
#1=IFCWALL('a',$,'A',$,$,$,$,$,$);
#2=IFCWALL('b',$,'B',$,$,$,$,$,$);
#3=IFCWALLTYPE('t',$,'WT',$,$,(#5),$,$,$,$);
#4=IFCRELDEFINESBYTYPE('r',$,$,$,(#1,#2),#3);
#5=IFCPROPERTYSET('p',$,'Pset_WallCommon',$,(#6));
#6=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('REI60'),$);
#7=IFCCLASSIFICATIONREFERENCE($,'EF_25_10','Walls',$,$,$);
#8=IFCRELASSOCIATESCLASSIFICATION('c',$,$,$,(#1),#7);
#9=IFCMATERIALLAYER(#14,0.15,$,$,$,$,$);
#10=IFCMATERIALLAYER(#15,0.05,$,$,$,$,$);
#11=IFCMATERIALLAYERSET((#9,#10),'WT-200',$);
#12=IFCMATERIALLAYERSETUSAGE(#11,.AXIS2.,.POSITIVE.,0.,$);
#13=IFCRELASSOCIATESMATERIAL('m',$,$,$,(#1),#12);
#14=IFCMATERIAL('Brick',$,$);
#15=IFCMATERIAL('Insulation',$,$);
ENDSEC;`;
test('#9296 classification must relate the selected wall', () => {
  const s = readStep(fixture);
  assert.equal(classificationOf(s,1),true);
  assert.equal(classificationOf(s,2),false);
});
test('#9296 shared FireRating lives on HasPropertySets without an occurrence copy', () => {
  const s = readStep(fixture);
  assert.equal(inheritedFireRating(s,s.of('IFCWALL')),true);
  const duplicate = readStep(fixture.replace('ENDSEC;', "#14=IFCRELDEFINESBYPROPERTIES('d',$,$,$,(#1),#5);\nENDSEC;"));
  assert.equal(inheritedFireRating(duplicate,duplicate.of('IFCWALL')),false);
  assert.equal(typeOf(s,1),3);
});
test('#9296 layer usage must reference the requested ordered set', () => {
  const s = readStep(fixture);
  assert.equal(layerUsage(s,s.get(1),[.15,.05]),true);
  assert.equal(layerUsage(s,s.get(1),[.05,.15]),false);
  assert.equal(layerUsage(s,s.get(2),[.15,.05]),false);
  const unassigned = readStep(fixture.replace("#13=IFCRELASSOCIATESMATERIAL('m',$,$,$,(#1),#12);",''));
  assert.equal(unassigned.of('IFCMATERIALLAYERSET').length,1);
  assert.equal(layerUsage(unassigned,unassigned.get(1),[.15,.05]),false);
});
test('#9296 schedule cell reader rejects missing totals and reads displayed units', () => {
  assert.equal(scheduleTotal('10.00 m'),10);
  assert.equal(scheduleTotal('11.00'),11);
  assert.ok(Number.isNaN(scheduleTotal('')));
  assert.ok(Number.isNaN(scheduleTotal('Total · 2')));
});

test('#9296 grid displacement preserves binding and measures the same column by GlobalId', async () => {
  const { gridCarriedColumn } = await import('./measured-oracles.mjs');
  const grid = `DATA;
#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCAXIS2PLACEMENT3D(#1,$,$);
#3=IFCLOCALPLACEMENT($,#2);
#4=IFCCARTESIANPOINT((0.,0.));
#5=IFCCARTESIANPOINT((10.,0.));
#6=IFCCARTESIANPOINT((0.,10.));
#7=IFCPOLYLINE((#4,#5));
#8=IFCPOLYLINE((#4,#6));
#9=IFCGRIDAXIS('A',#7,.T.);
#10=IFCGRIDAXIS('1',#8,.T.);
#11=IFCGRID('grid',$,$,$,$,#3,$,(#9),(#10),$,$);
#12=IFCVIRTUALGRIDINTERSECTION((#9,#10),(0.,0.));
#13=IFCGRIDPLACEMENT(#12,$);
#14=IFCLOCALPLACEMENT(#13,#2);
#15=IFCCOLUMN('column',$,$,$,$,#14,$,$,$);
ENDSEC;`;
  const before = readStep(grid);
  const moved = readStep(grid.replace('#1=IFCCARTESIANPOINT((0.,0.,0.))','#1=IFCCARTESIANPOINT((1.,0.,0.))').replace('#14=IFCLOCALPLACEMENT(#13,#2)','#14=IFCGRIDPLACEMENT(#12,$)'));
  assert.equal(gridCarriedColumn(before,moved),true);
  assert.equal(gridCarriedColumn(before,before),false);
  assert.equal(gridCarriedColumn(readStep('DATA; ENDSEC;'),moved),false);
});

test('#9874 an unused Brick definition cannot satisfy a wall material assignment', () => {
  const good = readStep(fixture);
  assert.deepEqual(assignedLayerMaterials(good,1),['Brick','Insulation']);
  const decoy = readStep(fixture.replace("#14=IFCMATERIAL('Brick'", "#14=IFCMATERIAL('Concrete'")
    .replace('ENDSEC;', "#16=IFCMATERIAL('Brick',$,$);\nENDSEC;"));
  assert.ok(decoy.of('IFCMATERIAL').some(m => m.args[0] === 'Brick'));
  assert.deepEqual(assignedLayerMaterials(decoy,1),['Concrete','Insulation']);
  assert.equal(assignedLayerMaterials(decoy,1).includes('Brick'),false);
  assert.deepEqual(assignedLayerMaterials(good,2),[]);
});

test('#9874 a duplicated CSV wall cannot substitute for the other equal-length wall', async () => {
  const { scheduleMatchesWalls } = await import('./authoring-helpers.mjs');
  const walls = [{Name:'Wall, A',Length:5},{Name:'Wall B',Length:5}];
  assert.equal(scheduleMatchesWalls('Name,Length (m)\r\n"Wall, A",5\r\nWall B,5',walls),true);
  assert.equal(scheduleMatchesWalls('Name,Length (m)\r\n"Wall, A",5\r\n"Wall, A",5',walls),false);
  assert.equal(scheduleMatchesWalls('Name,Length (m)\r\n"Wall, A",5\r\nWall B,6',walls),false);
});

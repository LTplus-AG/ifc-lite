/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { deriveCatalogue } from '../tests/structural-coverage/catalogue.mjs';
import { readStep } from '../tests/structural-coverage/lib/step.mjs';
import { extraction, readRow } from '../tests/structural-coverage/probes/read.mjs';

const { rows, tables } = deriveCatalogue(resolve(import.meta.dirname, '..'));
const empty = () => ({ members: [], connections: [], activities: [], loadGroups: [], resultGroups: [], analysisModels: [] });
// Isolate a stated attribute invariant using real schema positions and STEP values.
async function check(entity, own, values, model, extra = '', schema = 'IFC4') {
  const row = { ...rows.find((r) => r.schema === schema && r.entity === entity), own, rooted: false };
  assert.ok(row.attributes);
  const args = row.attributes.map((a) => values[a] ?? '$').join(',');
  const step = readStep(`ISO-10303-21;HEADER;FILE_SCHEMA(('${schema}'));ENDSEC;DATA;#1=${entity.toUpperCase()}(${args});${extra}ENDSEC;END-ISO-10303-21;`);
  const file = { path: 'observation.ifc', sha256: 'a', step };
  const ctx = { cache: new Map([['store:observation.ifc', {}]]), pkgs: { parser: { extractStructuralOnDemand: () => model } } };
  return readRow(row, [{ file, ix: await extraction(ctx, file) }], tables[schema].types);
}
const rejects = (v, attr) => {
  assert.ok(['fail', 'partial'].includes(v.status), JSON.stringify(v));
  if (attr) assert.ok(v.reason.includes(attr), v.reason);
};

test('#9668 nested relationship resources: values must match, not merely be indexed', async () => {
  const cases = [
    ['AppliedCondition', 'IfcBoundaryNodeCondition', 'TranslationalStiffnessX', 42],
    ['AdditionalConditions', 'IfcFailureConnectionCondition', 'TensionFailureX', 42],
    ['AdditionalConditions', 'IfcSlippageConnectionCondition', 'SlippageX', 42],
    ['ConnectionConstraint', 'IfcConnectionPointEccentricity', 'EccentricityInX', 0.25],
  ];
  for (const [field, type, attr, value] of cases) {
    const run = (read) => {
      const resource = { expressId: 1, type, components: { [attr]: read } };
      if (field === 'ConnectionConstraint') { delete resource.type; delete resource.components; resource[attr] = read; }
      return check(type, [attr], { [attr]: String(value) }, { ...empty(), members: [{ expressId: 2, type: 'IfcStructuralCurveMember', IfcRelConnectsStructuralMember: [{ expressId: 3, [field]: resource }] }] });
    };
    assert.equal((await run(value)).status, 'pass', type);
    rejects(await run(value + 1), attr);
  }
});

test('#9668 IFC2X3 physical relationship observes the member physicalElementIds', async () => {
  const run = (ids) => check('IfcRelConnectsStructuralElement', [], { RelatingElement: '#2', RelatedStructuralMember: '#3' },
    { ...empty(), members: [{ expressId: 3, globalId: 'm', type: 'IfcStructuralCurveMember', physicalElementIds: ids }] },
    "#2=IFCWALL('wall');#3=IFCSTRUCTURALCURVEMEMBER('m');", 'IFC2X3');
  assert.equal((await run([2])).status, 'pass');
  rejects(await run([4]));
  rejects(await run([]));
});

test('#9668 member relationship attributes compare the exact relationship record', async () => {
  const values = { RelatingStructuralMember: '#2', RelatedStructuralConnection: '#3', AppliedCondition: '#4', AdditionalConditions: '#5', SupportedLength: '2.5', ConditionCoordinateSystem: '#6', ConnectionConstraint: '#7' };
  const good = { expressId: 1, AppliedCondition: { expressId: 4 }, AdditionalConditions: { expressId: 5 }, SupportedLength: 2.5, ConditionCoordinateSystem: 6, ConnectionConstraint: { expressId: 7 } };
  const own = Object.keys(values).filter((a) => !a.startsWith('Relat'));
  const run = (rel) => check('IfcRelConnectsWithEccentricity', own, values, { ...empty(),
    members: [{ expressId: 2, type: 'IfcStructuralCurveMember', globalId: 'm', connectionGlobalIds: ['c'], IfcRelConnectsStructuralMember: [rel] }],
    connections: [{ expressId: 3, type: 'IfcStructuralPointConnection', globalId: 'c', memberGlobalIds: ['m'] }],
  }, "#2=IFCSTRUCTURALCURVEMEMBER('m');#3=IFCSTRUCTURALPOINTCONNECTION('c');");
  assert.equal((await run(good)).status, 'pass');
  for (const attr of own) rejects(await run({ ...good, [attr]: typeof good[attr] === 'number' ? 99 : { expressId: 99 } }), attr);
  rejects(await run({ ...good, expressId: 99 }), 'unexposed');
});

test('#9668 reference arrays normalize ids while retaining multiplicity and numeric measures', async () => {
  const run = (ids, stations = [0, 0.5, 1]) => check('IfcStructuralLinearActionVarying', ['SubsequentAppliedLoads', 'VaryingAppliedLoadLocation'], { SubsequentAppliedLoads: '(#2,#3,#2)', VaryingAppliedLoadLocation: '(0.,0.5,1.)' },
    { ...empty(), activities: [{ expressId: 1, type: 'IfcStructuralLinearActionVarying', SubsequentAppliedLoads: ids, VaryingAppliedLoadLocation: stations }] },
    '#2=IFCSTRUCTURALLOADSINGLEFORCE();#3=IFCSTRUCTURALLOADSINGLEFORCE();', 'IFC2X3');
  assert.equal((await run([2, 3, 2])).status, 'pass');
  for (const ids of [[2, 3, 99], [2, 3], [2, 3, 3], [2, 3, 2, 2]]) rejects(await run(ids), 'SubsequentAppliedLoads');
  rejects(await run([2, 3, 2], [0, 1, 0.5]), 'VaryingAppliedLoadLocation');
});

test('#9668 read indexes subsequent loads recursively and still rejects wrong or missing values', async () => {
  const run = (force, include = true, nested = false) => {
    const load = { expressId: 1, type: 'IfcStructuralLoadLinearForce', components: { LinearForceX: force } };
    const subsequent = nested ? { expressId: 5, type: 'IfcStructuralLoadConfiguration', configuration: { entries: [{ value: load }] } } : load;
    return check('IfcStructuralLoadLinearForce', ['LinearForceX'], { LinearForceX: '5.' },
      { ...empty(), activities: [{ expressId: 2, type: 'IfcStructuralLinearActionVarying', subsequentLoads: include ? [undefined, subsequent] : [] }] }, '', 'IFC2X3');
  };
  for (const nested of [false, true]) {
    assert.equal((await run(5, true, nested)).status, 'pass');
    rejects(await run(6, true, nested), 'LinearForceX');
    rejects(await run(5, false, nested), 'not in the read model');
  }
});

test('#9668 read accepts normalized activity links in either STEP orientation and rejects unrelated ends', async () => {
  const run = (swapped, { target = 'item', activity = true, itemActivities = ['activity'], item = true, itemType = 'IFCSTRUCTURALPOINTCONNECTION' } = {}) => check(
    'IfcRelConnectsStructuralActivity', [],
    { RelatingElement: swapped ? '#3' : '#2', RelatedStructuralActivity: swapped ? '#2' : '#3' },
    { ...empty(),
      connections: item ? [{ expressId: 2, type: 'IfcStructuralPointConnection', globalId: 'item', activityGlobalIds: itemActivities }] : [],
      activities: activity ? [{ expressId: 3, type: 'IfcStructuralPointAction', globalId: 'activity', appliesToGlobalId: target }] : [],
    }, `#2=${itemType}('item');#3=IFCSTRUCTURALPOINTACTION('activity');`, 'IFC4X3');
  for (const swapped of [false, true]) {
    assert.equal((await run(swapped)).status, 'pass');
    rejects(await run(swapped, { target: 'other' }), 'link');
    rejects(await run(swapped, { activity: false }), 'link');
    rejects(await run(swapped, { itemActivities: [] }), 'link');
    // A structural item the read model dropped still fails.
    rejects(await run(swapped, { item: false }), 'link');
  }
  // A physical element end is not in the structural read model and is exempt; a dangling end is not.
  assert.equal((await run(false, { item: false, itemType: 'IFCBEAM' })).status, 'pass');
  rejects(await check('IfcRelConnectsStructuralActivity', [], { RelatingElement: '#9', RelatedStructuralActivity: '#3' },
    { ...empty(), activities: [{ expressId: 3, type: 'IfcStructuralPointAction', globalId: 'activity', appliesToGlobalId: '#9' }] },
    "#3=IFCSTRUCTURALPOINTACTION('activity');", 'IFC4X3'), 'link');
});

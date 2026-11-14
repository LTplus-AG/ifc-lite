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

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Fixtures for IDSL-ENT-*, IDSL-PDT-* and IDSL-ATT-* (IDS-047). */

import { beforeAll, describe, expect, it } from 'vitest';
import { attribute, docFromXml, entity, enumeration, idsXml, lintCode, runRuleFixtures, specXml, sv, type RuleFixtures } from '../../../test/lint-helpers.js';
import { emptyMeta } from '../../document/types.js';
import { createLintContext } from '../context.js';
import { quickFix } from '../fix.js';
import type { LintContext } from '../types.js';
import { setValues } from './entity.js';
import { gated } from './util.js';

let ctx: LintContext;
beforeAll(async () => {
  ctx = await createLintContext();
});

const one = (app: string, req = '', versions = 'IFC4') => idsXml(specXml(app, req, `ifcVersion="${versions}"`));
const entityEnum = (values: string[]) => `<entity><name>${enumeration(values)}</name></entity>`;
const partOf = (relation: string, name: string) => `<partOf relation="${relation}">${entity(name)}</partOf>`;

const FIXTURES: RuleFixtures[] = [
  {
    code: 'IDSL-ENT-001',
    positive: [one(entity('IFCBUILDINGELEMENT')), one(entity('IFCWALL'), entity('IFCFEATUREELEMENTSUBTRACTION')), one(entityEnum(['IFCWALL', 'IFCSPATIALSTRUCTUREELEMENT']))],
    negative: [one(entity('IFCWALL')), one(entityEnum(['IFCWALL', 'IFCSLAB']))],
    fixes: 1,
  },
  {
    code: 'IDSL-ENT-002',
    positive: [one(entity('IFCWALLELEMENTEDCASE')), one(entity('IFCBEAMSTANDARDCASE'))],
    negative: [one(entity('IFCWALL')), one(entityEnum(['IFCBEAMSTANDARDCASE', 'IFCBEAM'])), one(entity('IFCWALL'), '', 'IFC4 IFC4X3_ADD2')],
    fixes: 1,
  },
  {
    code: 'IDSL-ENT-003',
    positive: [one(entity('IFCWALL')), one(entity('IFCBEAM'))],
    negative: [one(entity('IFCSPACE'), '', 'IFC4X3_ADD2'), one(entityEnum(['IFCWALL', 'IFCWALLSTANDARDCASE', 'IFCWALLELEMENTEDCASE'])), one(entity('IFCDOOR'), '', 'IFC4X3_ADD2')],
    fixes: 1,
  },
  {
    code: 'IDSL-ENT-004',
    positive: [
      one(entity('IFCDOORTYPE'), partOf('IFCRELCONTAINEDINSPATIALSTRUCTURE', 'IFCBUILDINGSTOREY')),
      one(entity('IFCWINDOWTYPE') + partOf('IFCRELCONTAINEDINSPATIALSTRUCTURE', 'IFCBUILDINGSTOREY')),
    ],
    negative: [one(entity('IFCDOOR'), partOf('IFCRELCONTAINEDINSPATIALSTRUCTURE', 'IFCBUILDINGSTOREY')), one(entity('IFCDOORTYPE'), attribute('Name'))],
    fixes: 1,
  },
  {
    code: 'IDSL-ENT-005',
    positive: [one(entity('IfcWall')), one(entity('IFCWALL'), partOf('IFCRELCONTAINEDINSPATIALSTRUCTURE', 'IfcBuildingStorey'))],
    negative: [one(entity('IFCWALL')), one(entity('IFCWALL'), partOf('IFCRELCONTAINEDINSPATIALSTRUCTURE', 'IFCBUILDINGSTOREY'))],
    fixes: 1,
  },
  {
    code: 'IDSL-PDT-001',
    positive: [one(entity('IFCALIGNMENTHORIZONTALSEGMENT', 'LINES'), '', 'IFC4X3_ADD2'), one(entity('IFCALIGNMENTVERTICALSEGMENT', 'CONSTANTGRADEE'), '', 'IFC4X3_ADD2')],
    negative: [one(entity('IFCALIGNMENTHORIZONTALSEGMENT', 'LINE'), '', 'IFC4X3_ADD2'), one(entity('IFCWALL', 'WALDO'))],
    fixes: 1,
  },
  {
    code: 'IDSL-PDT-002',
    positive: [one(entity('IFCWALL', 'USERDEFINED')), one(entity('IFCWALLTYPE', 'USERDEFINED'))],
    negative: [one(entity('IFCWALL', 'USERDEFINED'), attribute('ObjectType')), one(entity('IFCWALL', 'SHEAR'))],
    fixes: 1,
  },
  {
    code: 'IDSL-PDT-003',
    positive: [one(entity('IFCWALL', 'PARAPETT')), one(entity('IFCWALL', 'solidwall'))],
    negative: [
      one(entity('IFCWALL', 'PARAPET')),
      docFromXml(one(entity('IFCWALL', 'WALDO')), { ...emptyMeta(), custom: { psets: [], userDefinedTypes: [{ entity: 'IfcWall', value: 'WALDO' }] } }),
    ],
    fixes: 2,
  },
  {
    code: 'IDSL-ATT-001',
    positive: [one(entity('IFCWALL'), attribute('Nmae')), one(entity('IFCWALL') + attribute('Tagg'))],
    negative: [one(entity('IFCWALL'), attribute('Name')), one(`<property><propertySet>${sv('X')}</propertySet><baseName>${sv('Y')}</baseName></property>`, attribute('Whatever'))],
    fixes: 1,
  },
  {
    code: 'IDSL-ATT-002',
    positive: [one(entity('IFCWALL'), attribute('ObjectPlacement', sv('x'))), one(entity('IFCWALL'), attribute('OwnerHistory', sv('x')))],
    negative: [one(entity('IFCWALL'), attribute('Name', sv('x'))), one(entity('IFCWALL'), attribute('ObjectPlacement'))],
    fixes: 1,
  },
];

describe('entity, predefined type and attribute rules', () => {
  for (const f of FIXTURES) it(f.code, () => runRuleFixtures(ctx, f));

  it('ENT-001 expands an abstract class in place, keeping the other values', () => {
    const { diagnostics } = lintCode(ctx, 'IDSL-ENT-001', one(entityEnum(['IFCWALL', 'IFCBUILDINGELEMENT'])));
    const op = diagnostics[0].fixes![0].ops[0];
    expect(op.kind).toBe('value.set');
    const values = op.kind === 'value.set' && op.payload.value.kind === 'oneOf' ? op.payload.value.values : [];
    expect(values[0]).toBe('IFCWALL');
    expect(values).toContain('IfcSlab');
    expect(values.filter((v) => String(v).toUpperCase() === 'IFCWALL')).toHaveLength(1);
  });

  it('drops quick fixes that the grounding gate refuses', () => {
    const doc = docFromXml(one(entity('IFCWALL')));
    const facetId = doc.nodes.specs[0].applicability[0].id;
    const bad = quickFix('Invent a class', 'IDSL-ENT-001', facetId, 'bad', [setValues(facetId, 'entity.name', ['IfcNotAClass'])]);
    const good = quickFix('Use IfcSlab', 'IDSL-ENT-001', facetId, 'good', [setValues(facetId, 'entity.name', ['IfcSlab'])]);
    expect(gated(doc, ctx, [bad, undefined, good])?.map((f) => f.label)).toEqual(['Use IfcSlab']);
    expect(gated(doc, ctx, [bad])).toBeUndefined();
  });

  it('PDT-003 offers the case-corrected enumeration value first', () => {
    const { diagnostics } = lintCode(ctx, 'IDSL-PDT-003', one(entity('IFCWALL', 'solidwall')));
    expect(diagnostics[0].fixes!.map((f) => f.label)).toEqual(['Use SOLIDWALL', 'Declare "solidwall" as a user-defined type of IfcWall']);
  });

  it('PDT-002 asks for ElementType on type objects', () => {
    const { diagnostics } = lintCode(ctx, 'IDSL-PDT-002', one(entity('IFCWALLTYPE', 'USERDEFINED')));
    expect(diagnostics[0].message).toContain('ElementType');
  });
});

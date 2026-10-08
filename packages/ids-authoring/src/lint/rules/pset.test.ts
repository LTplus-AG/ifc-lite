/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Fixtures for IDSL-PSET-* and IDSL-PROP-* (IDS-048). */

import { beforeAll, describe, expect, it } from 'vitest';
import { entity, enumeration, idsXml, lintCode, property, restriction, runRuleFixtures, specXml, sv, type RuleFixtures } from '../../../test/lint-helpers.js';
import { createLintContext } from '../context.js';
import type { LintContext } from '../types.js';

let ctx: LintContext;
beforeAll(async () => {
  ctx = await createLintContext();
});

const one = (app: string, req = '', versions = 'IFC4') => idsXml(specXml(app, req, `ifcVersion="${versions}"`));
const range = restriction('xs:double', '<xs:minInclusive value="0"/><xs:maxInclusive value="0.5"/>');

const FIXTURES: RuleFixtures[] = [
  {
    code: 'IDSL-PSET-001',
    positive: [one(entity('IFCDOOR'), property('Pset_WallCommon', 'IsExternal')), one(entity('IFCSLAB'), property('Pset_WallCommon', 'FireRating'))],
    negative: [one(entity('IFCWALL'), property('Pset_WallCommon', 'IsExternal')), one(entity('IFCWALLTYPE'), property('Pset_WallCommon', 'IsExternal')), one(entity('IFCWALLSTANDARDCASE'), property('Pset_WallCommon', 'IsExternal'))],
  },
  {
    code: 'IDSL-PSET-002',
    positive: [one(entity('IFCWALL'), property('Pset_WallComon', 'IsExternal')), one(entity('IFCWALL'), property('Pset_MyCompanyData', 'Foo'))],
    negative: [one(entity('IFCWALL'), property('Pset_WallCommon', 'IsExternal')), one(entity('IFCWALL'), property('Qto_Anything', 'Foo')), one(entity('IFCWALL'), property('Project_Data', 'Foo'))],
    fixes: 2,
  },
  {
    code: 'IDSL-PSET-003',
    positive: [
      one(entity('IFCWALL'), property('Qto_WallBaseQuantities', 'Length', { dataType: 'IFCLABEL' }), 'IFC4X3_ADD2'),
      one(entity('IFCWALL'), property('Qto_WallBaseQuantities', 'Length', { value: sv('long') }), 'IFC4X3_ADD2'),
    ],
    negative: [
      one(entity('IFCWALL'), property('Qto_WallBaseQuantities', 'Length', { dataType: 'IFCLENGTHMEASURE', value: sv('2.5') }), 'IFC4X3_ADD2'),
      one(entity('IFCWALL'), property('Pset_WallCommon', 'FireRating', { dataType: 'IFCLABEL' })),
    ],
    fixes: 1,
  },
  {
    code: 'IDSL-PROP-001',
    positive: [one(entity('IFCDOOR'), property('Pset_DoorCommon', 'FireRatng')), one(entity('IFCDOOR'), property('Pset_DoorCommon', 'IsExternall'))],
    negative: [one(entity('IFCDOOR'), property('Pset_DoorCommon', 'FireRating')), one(entity('IFCDOOR'), property('Foo_Bar', 'Anything'))],
  },
  {
    code: 'IDSL-PROP-002',
    positive: [one(entity('IFCWALL'), property('Pset_WallCommon', 'IsExternal', { dataType: 'IFCREAL' })), one(entity('IFCDOOR'), property('Pset_DoorCommon', 'FireRating', { dataType: 'IFCTEXT' }))],
    negative: [
      one(entity('IFCWALL'), property('Pset_WallCommon', 'IsExternal', { dataType: 'IFCBOOLEAN' })),
      one(entity('IFCWALL'), property('Pset_WallCommon', 'IsExternal', { dataType: 'IFCPROPERTYSINGLEVALUE' })),
      one(entity('IFCWALL'), property('Foo_Bar', 'IsExternal', { dataType: 'IFCREAL' })),
    ],
    fixes: 1,
  },
  {
    code: 'IDSL-PROP-003',
    positive: [one(entity('IFCWALL'), property('Pset_WallCommon', 'ThermalTransmittance', { value: range })), one(entity('IFCWALL'), property('Foo_Bar', 'Height', { value: enumeration(['2', '3'], 'xs:double') }))],
    negative: [
      one(entity('IFCWALL'), property('Pset_WallCommon', 'ThermalTransmittance', { dataType: 'IFCTHERMALTRANSMITTANCEMEASURE', value: range })),
      one(entity('IFCWALL'), property('Foo_Bar', 'Code', { value: enumeration(['A', 'B']) })),
    ],
    fixes: 1,
  },
];

describe('property set and property rules', () => {
  for (const f of FIXTURES) it(f.code, () => runRuleFixtures(ctx, f));

  it('PSET-001 suggests the applicable set holding the same property', () => {
    const { diagnostics } = lintCode(ctx, 'IDSL-PSET-001', one(entity('IFCDOOR'), property('Pset_WallCommon', 'IsExternal')));
    expect(diagnostics[0].fixes?.map((f) => f.label)).toContain('Use Pset_DoorCommon');
  });

  it('PSET-002 offers the standard name and a declared project-prefixed rename', () => {
    const { diagnostics } = lintCode(ctx, 'IDSL-PSET-002', one(entity('IFCWALL'), property('Pset_WallComon', 'IsExternal')));
    expect(diagnostics[0].fixes?.map((f) => f.label)).toEqual(['Use Pset_WallCommon', 'Rename to Project_WallComon (custom set)']);
    expect(diagnostics[0].fixes?.[1].ops.map((o) => o.kind)).toEqual(['meta.custom.declarePset', 'value.set']);
  });

  it('PROP-001 points to the set that defines the property', () => {
    const { diagnostics } = lintCode(ctx, 'IDSL-PROP-001', one(entity('IFCDOOR'), property('Pset_DoorCommon', 'FireRatng')));
    expect(diagnostics[0].fixes?.[0].label).toBe('Use FireRating');
  });
});

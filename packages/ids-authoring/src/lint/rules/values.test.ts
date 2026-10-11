/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Fixtures for IDSL-VAL-* and IDSL-UNIT-* (IDS-049). */

import { beforeAll, describe, expect, it } from 'vitest';
import { attribute, entity, enumeration, idsXml, lintCode, pattern, property, restriction, runRuleFixtures, specXml, sv, type RuleFixtures } from '../../../test/lint-helpers.js';
import { createLintContext } from '../context.js';
import type { LintContext } from '../types.js';
import { listItems, parseComparison } from './values.js';

let ctx: LintContext;
beforeAll(async () => {
  ctx = await createLintContext();
});

const one = (app: string, req = '', versions = 'IFC4') => idsXml(specXml(app, req, `ifcVersion="${versions}"`));
const wall = (req: string) => one(entity('IFCWALL'), req);
const custom = (value: string, dataType?: string, name = 'Code') => wall(property('Foo_Bar', name, { value, ...(dataType ? { dataType } : {}) }));
const bounds = (inner: string, base = 'xs:double') => restriction(base, inner);

const FIXTURES: RuleFixtures[] = [
  {
    code: 'IDSL-VAL-001',
    positive: [one(entity('IFCDOOR'), property('Pset_DoorCommon', 'Status', { value: sv('New') })), one(entity('IFCDOOR'), property('Pset_DoorCommon', 'Status', { value: enumeration(['NEW', 'EXISTNG']) }))],
    negative: [one(entity('IFCDOOR'), property('Pset_DoorCommon', 'Status', { value: sv('NEW') })), custom(sv('New'))],
    fixes: 1,
  },
  {
    code: 'IDSL-VAL-002',
    positive: [custom(bounds('<xs:minInclusive value="1"/>'), 'IFCLABEL'), custom(pattern('tr.*'), 'IFCBOOLEAN')],
    negative: [custom(pattern('A.*'), 'IFCLABEL'), custom(bounds('<xs:minInclusive value="1"/>'), 'IFCREAL'), custom(bounds('<xs:minInclusive value="1"/>', 'xs:decimal'), 'IFCREAL')],
    fixes: 1,
  },
  {
    code: 'IDSL-VAL-003',
    positive: [custom(sv('EI60, EI90')), custom(sv('[A1;B2;C3]')), custom(sv('EI60/EI90'))],
    negative: [custom(sv('Concrete, reinforced')), custom(sv('EI60')), custom(sv('1,5'))],
    fixes: 1,
  },
  {
    code: 'IDSL-VAL-004',
    positive: [custom(sv('&gt;= 30')), custom(sv('&lt;0.5')), custom(sv('&gt; 2400 mm'), 'IFCLENGTHMEASURE')],
    negative: [custom(sv('30')), custom(sv('a&gt;b'))],
    fixes: 1,
  },
  {
    code: 'IDSL-VAL-005',
    positive: [custom(sv('TRUE'), 'IFCBOOLEAN'), one(entity('IFCTASK'), attribute('IsMilestone', sv('FALSE'))), custom(enumeration(['yes'], 'xs:boolean'), 'IFCBOOLEAN')],
    negative: [custom(sv('true'), 'IFCBOOLEAN'), custom(sv('TRUE'), 'IFCLABEL')],
    fixes: 1,
  },
  {
    code: 'IDSL-VAL-006',
    positive: [custom(sv('EI60 ')), wall(property('Foo_Bar', 'Fire&#160;Rating'))],
    negative: [custom(sv('EI60')), wall(property('Foo_Bar', 'Fire Rating'))],
    fixes: 1,
  },
  {
    code: 'IDSL-VAL-008',
    positive: [custom(sv('2.4'), 'IFCREAL'), wall(property('Pset_WallCommon', 'ThermalTransmittance', { value: sv('0.3') }))],
    negative: [custom(bounds('<xs:minInclusive value="2.3"/><xs:maxInclusive value="2.5"/>'), 'IFCREAL'), custom(sv('3'), 'IFCINTEGER'), custom(sv('2.4'), 'IFCLABEL')],
  },
  {
    code: 'IDSL-UNIT-001',
    positive: [
      custom(sv('2400'), 'IFCLENGTHMEASURE', 'Height'),
      custom(bounds('<xs:minInclusive value="15000000"/>'), 'IFCAREAMEASURE', 'Area'),
      custom(sv('240'), 'IFCLENGTHMEASURE', 'Thickness'),
    ],
    negative: [custom(sv('2.4'), 'IFCLENGTHMEASURE', 'Height'), custom(sv('500'), 'IFCLENGTHMEASURE', 'Length'), custom(sv('2400'), 'IFCLABEL', 'Height')],
    fixes: 1,
  },
];

describe('value and unit rules', () => {
  for (const f of FIXTURES) it(f.code, () => runRuleFixtures(ctx, f));

  it('VAL-003 splits lists and leaves prose alone', () => {
    expect(listItems('[EI60, EI90]')).toEqual(['EI60', 'EI90']);
    expect(listItems('EI60/EI90')).toEqual(['EI60', 'EI90']);
    expect(listItems('red, green, blue')).toEqual(['red', 'green', 'blue']);
    expect(listItems('Concrete, reinforced')).toBeUndefined();
    expect(listItems('N/A')).toBeUndefined();
  });

  it('VAL-004 parses comparisons with decimal comma and units', () => {
    expect(parseComparison('≥ 0,9')).toEqual({ op: '>=', value: 0.9 });
    expect(parseComparison('<2400mm')).toEqual({ op: '<', value: 2400, unit: 'mm' });
    expect(parseComparison('= 3')).toBeUndefined();
  });

  it('UNIT-001 converts millimetres to metres', () => {
    const { diagnostics } = lintCode(ctx, 'IDSL-UNIT-001', custom(sv('2400'), 'IFCLENGTHMEASURE', 'Height'));
    const op = diagnostics[0].fixes![0].ops[0];
    expect(op.kind === 'value.set' && op.payload.value).toEqual({ kind: 'raw', constraint: { type: 'simpleValue', value: '2.4' } });
  });

  it('VAL-004 converts a unit to SI', () => {
    const { diagnostics } = lintCode(ctx, 'IDSL-VAL-004', custom(sv('&gt; 2400 mm'), 'IFCLENGTHMEASURE'));
    expect(diagnostics[0].fixes).toHaveLength(1);
  });
});

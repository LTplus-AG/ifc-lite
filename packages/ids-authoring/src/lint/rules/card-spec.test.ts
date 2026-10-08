/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Fixtures for IDSL-CARD-* and IDSL-SPEC-* (IDS-051). */

import { beforeAll, describe, expect, it } from 'vitest';
import { attribute, entity, enumeration, idsXml, lintCode, pattern, property, restriction, runRuleFixtures, specXml, sv, type RuleFixtures } from '../../../test/lint-helpers.js';
import { createLintContext } from '../context.js';
import type { LintContext } from '../types.js';

let ctx: LintContext;
beforeAll(async () => {
  ctx = await createLintContext();
});

const one = (app: string, req = '', attrs = 'ifcVersion="IFC4"') => idsXml(specXml(app, req, attrs));
/** A spec with explicit applicability cardinality. */
const card = (min: string, max: string, app: string, req = '') =>
  idsXml(`<specification name="S" ifcVersion="IFC4"><applicability minOccurs="${min}" maxOccurs="${max}">${app}</applicability>${req ? `<requirements>${req}</requirements>` : ''}</specification>`);
const W = entity('IFCWALL');
const fr = (opts: Parameters<typeof property>[2] = {}) => property('Foo_Bar', 'FireRating', opts);
const num = (inner: string) => restriction('xs:double', inner);

const FIXTURES: RuleFixtures[] = [
  {
    code: 'IDSL-CARD-001',
    positive: [one(W, fr({ value: sv('EI30'), cardinality: 'prohibited' })), one(W, attribute('Name', sv('X'), 'prohibited'))],
    negative: [one(W, fr({ cardinality: 'prohibited' })), one(W, fr({ value: sv('EI30') }))],
    fixes: 1,
  },
  {
    code: 'IDSL-CARD-002',
    positive: [one(W, fr({ cardinality: 'optional' })), one(W, attribute('Description', undefined, 'optional'))],
    negative: [one(W, fr({ cardinality: 'optional', value: sv('EI30') })), one(W, fr({ cardinality: 'optional', dataType: 'IFCLABEL' })), one(W, `<classification cardinality="optional"><system>${sv('Uniclass')}</system></classification>`)],
    fixes: 2,
  },
  {
    code: 'IDSL-CARD-003',
    positive: [card('0', '0', W, fr()), card('0', '0', W, fr() + attribute('Name'))],
    negative: [card('0', '0', W), card('0', 'unbounded', W, fr())],
    fixes: 2,
  },
  {
    code: 'IDSL-CARD-004',
    positive: [card('1', 'unbounded', W + fr({ value: sv('EI30') }), attribute('Name')), card('1', 'unbounded', W + `<partOf relation="IFCRELCONTAINEDINSPATIALSTRUCTURE">${entity('IFCBUILDINGSTOREY')}</partOf>`, attribute('Name'))],
    negative: [card('1', 'unbounded', W, attribute('Name')), card('0', 'unbounded', W + fr({ value: sv('EI30') }), attribute('Name'))],
    fixes: 1,
  },
  {
    code: 'IDSL-SPEC-001',
    positive: [one(W, W), one(W + fr({ value: sv('EI60') }), fr()), one(W + fr({ value: sv('EI60') }), fr({ value: enumeration(['EI60', 'EI90']) }))],
    negative: [one(W + fr({ value: sv('EI60') }), fr({ value: enumeration(['EI90']) })), one(W + fr(), fr({ dataType: 'IFCLABEL' })), one(W + fr(), fr({ cardinality: 'optional' }))],
    fixes: 1,
  },
  {
    code: 'IDSL-SPEC-002',
    positive: [
      one(W, fr({ value: sv('EI60') }) + fr({ value: sv('EI90') })),
      one(W + fr({ value: sv('EI60') }), fr({ value: sv('EI90') })),
      one(W, property('Foo_Bar', 'Width', { value: num('<xs:maxInclusive value="1"/>') }) + property('Foo_Bar', 'Width', { value: num('<xs:minExclusive value="1"/>') })),
    ],
    negative: [
      one(W, fr({ value: enumeration(['EI60', 'EI90']) }) + fr({ value: sv('EI90') })),
      one(W, fr({ value: pattern('EI.*') }) + fr({ value: pattern('REI.*') })),
      one(W, fr({ value: sv('EI60') }) + property('Foo_Bar', 'Other', { value: sv('EI90') })),
    ],
  },
  {
    code: 'IDSL-SPEC-003',
    positive: [one(W + entity('IFCSLAB'), attribute('Name')), one(W + fr({ value: sv('A') }) + fr({ value: sv('B') }), attribute('Name'))],
    negative: [one(W + `<entity><name>${enumeration(['IFCWALL', 'IFCSLAB'])}</name></entity>`, attribute('Name')), one(W + fr({ value: pattern('A.*') }) + fr({ value: pattern('B.*') }), attribute('Name'))],
  },
  {
    code: 'IDSL-SPEC-005',
    positive: [
      idsXml(specXml(W, fr(), 'ifcVersion="IFC4"', 'A') + specXml(W, fr(), 'ifcVersion="IFC4"', 'B')),
      idsXml(specXml(W + fr({ value: sv('X') }), attribute('Name'), 'ifcVersion="IFC4"', 'A') + specXml(fr({ value: sv('X') }) + W, attribute('Name'), 'ifcVersion="IFC4"', 'B')),
    ],
    negative: [idsXml(specXml(W, fr(), 'ifcVersion="IFC4"', 'A') + specXml(W, attribute('Name'), 'ifcVersion="IFC4"', 'B')), idsXml(specXml(W, fr(), 'ifcVersion="IFC4"', 'A') + specXml(W, fr(), 'ifcVersion="IFC2X3"', 'B'))],
    fixes: 1,
  },
  {
    code: 'IDSL-SPEC-006',
    positive: [
      idsXml(specXml(W, fr({ value: sv('EI30') }), 'ifcVersion="IFC4"', 'A') + specXml(W, fr({ value: sv('EI60') }), 'ifcVersion="IFC4"', 'B')),
      idsXml(specXml(W, property('Foo_Bar', 'W', { value: num('<xs:maxInclusive value="1"/>') }), 'ifcVersion="IFC4"', 'A') + specXml(W, property('Foo_Bar', 'W', { value: num('<xs:minInclusive value="2"/>') }), 'ifcVersion="IFC4"', 'B')),
    ],
    negative: [
      idsXml(specXml(W, fr({ value: sv('EI30') }), 'ifcVersion="IFC4"', 'A') + specXml(entity('IFCDOOR'), fr({ value: sv('EI60') }), 'ifcVersion="IFC4"', 'B')),
      idsXml(specXml(W, fr({ value: enumeration(['EI30', 'EI60']) }), 'ifcVersion="IFC4"', 'A') + specXml(W, fr({ value: sv('EI60') }), 'ifcVersion="IFC4"', 'B')),
    ],
  },
  {
    code: 'IDSL-SPEC-007',
    positive: [card('0', 'unbounded', W), card('1', 'unbounded', W)],
    negative: [one(W, fr()), card('0', '0', W)],
  },
  {
    code: 'IDSL-SPEC-008',
    positive: [one(W, fr()), one(W, fr(), 'ifcVersion="IFC4" description="  "')],
    negative: [one(W, fr(), 'ifcVersion="IFC4" description="Fire rating of walls"'), one(W, fr(), 'ifcVersion="IFC4" instructions="Set FireRating on every wall"')],
  },
  {
    code: 'IDSL-SPEC-009',
    positive: [
      idsXml(specXml(W, fr(), 'ifcVersion="IFC4" identifier="FS-1"', 'A') + specXml(W, attribute('Name'), 'ifcVersion="IFC4" identifier="FS-1"', 'B')),
      idsXml(['A', 'B', 'C'].map((n, i) => specXml(W, attribute('Name'), `ifcVersion="IFC4" identifier="${i === 2 ? 'X-2' : 'X'}"`, n)).join('') + specXml(W, fr(), 'ifcVersion="IFC4" identifier="X"', 'D')),
    ],
    negative: [idsXml(specXml(W, fr(), 'ifcVersion="IFC4" identifier="FS-1"', 'A') + specXml(W, attribute('Name'), 'ifcVersion="IFC4" identifier="FS-2"', 'B')), idsXml(specXml(W, fr(), 'ifcVersion="IFC4"', 'A') + specXml(W, attribute('Name'), 'ifcVersion="IFC4"', 'B'))],
    fixes: 1,
  },
];

describe('cardinality and specification rules', () => {
  for (const f of FIXTURES) it(f.code, () => runRuleFixtures(ctx, f));

  it('SPEC-009 picks an unused identifier', () => {
    const xml = idsXml(['A', 'B', 'C'].map((n, i) => specXml(W, attribute('Name'), `ifcVersion="IFC4" identifier="${i === 2 ? 'X-2' : 'X'}"`, n)).join(''));
    expect(lintCode(ctx, 'IDSL-SPEC-009', xml).diagnostics[0].fixes![0].label).toBe('Renumber to X-3');
  });

  it('SPEC-007 distinguishes existence checks from no-ops', () => {
    expect(lintCode(ctx, 'IDSL-SPEC-007', card('1', 'unbounded', W)).diagnostics[0].message).toMatch(/exist/);
    expect(lintCode(ctx, 'IDSL-SPEC-007', card('0', 'unbounded', W)).diagnostics[0].message).toMatch(/checks nothing/);
  });
});

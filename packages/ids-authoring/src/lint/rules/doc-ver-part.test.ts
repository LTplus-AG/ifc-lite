/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Fixtures for IDSL-DOC-001, IDSL-VER-001 and IDSL-PART-001 (IDS-052). */

import { beforeAll, describe, expect, it } from 'vitest';
import { attribute, entity, idsXml, lintCode, runRuleFixtures, specXml, type RuleFixtures } from '../../../test/lint-helpers.js';
import { createLintContext } from '../context.js';
import type { LintContext } from '../types.js';
import { toXsDate } from './doc-ver-part.js';

let ctx: LintContext;
beforeAll(async () => {
  ctx = await createLintContext();
});

const one = (app: string, req = '', versions = 'IFC4') => idsXml(specXml(app, req, `ifcVersion="${versions}"`));
const withInfo = (info: string) => idsXml(specXml(entity('IFCWALL'), attribute('Name')), info);
const partOf = (relation: string, name: string) => `<partOf relation="${relation}">${entity(name)}</partOf>`;

const FIXTURES: RuleFixtures[] = [
  {
    code: 'IDSL-DOC-001',
    positive: [withInfo('<author>Jane Doe</author>'), withInfo('<date>08.10.2026</date>'), withInfo('<date>yesterday</date>')],
    negative: [withInfo('<author>jane@example.com</author><date>2026-10-08</date>'), withInfo('')],
    fixes: 1,
  },
  {
    code: 'IDSL-VER-001',
    positive: [one(entity('IFCBUILDINGSYSTEM'), attribute('Name'), 'IFC2X3 IFC4'), one(entity('IFCWALLELEMENTEDCASE'), attribute('Name'), 'IFC4 IFC4X3_ADD2')],
    negative: [one(entity('IFCAIRTERMINAL'), attribute('Name'), 'IFC2X3 IFC4'), one(entity('IFCWALL'), attribute('Name'), 'IFC2X3 IFC4')],
    fixes: 1,
  },
  {
    code: 'IDSL-PART-001',
    positive: [one(entity('IFCWALL'), partOf('IFCRELAGGREGATES', 'IFCBUILDINGSTOREY')), one(entity('IFCBUILDINGSTOREY'), partOf('IFCRELCONTAINEDINSPATIALSTRUCTURE', 'IFCBUILDING'))],
    negative: [
      one(entity('IFCWALL'), partOf('IFCRELCONTAINEDINSPATIALSTRUCTURE', 'IFCBUILDINGSTOREY')),
      one(entity('IFCBUILDINGSTOREY'), partOf('IFCRELAGGREGATES', 'IFCBUILDING')),
      one(entity('IFCBEAM'), partOf('IFCRELAGGREGATES', 'IFCELEMENTASSEMBLY')),
    ],
    fixes: 1,
  },
];

describe('document, version and partOf rules', () => {
  for (const f of FIXTURES) it(f.code, () => runRuleFixtures(ctx, f));

  it('DOC-001 normalises only unambiguous dates', () => {
    expect(toXsDate('2026/10/8')).toBe('2026-10-08');
    expect(toXsDate('8.10.2026')).toBe('2026-10-08');
    expect(toXsDate('2026-10-08T12:00:00Z')).toBe('2026-10-08');
    expect(toXsDate('10/08/2026')).toBeUndefined();
  });

  it('VER-001 restricts to the versions where every name exists', () => {
    const { diagnostics } = lintCode(ctx, 'IDSL-VER-001', one(entity('IFCBUILDINGSYSTEM'), attribute('Name'), 'IFC2X3 IFC4'));
    expect(diagnostics[0].fixes![0].label).toBe('Restrict to IFC4');
  });
});

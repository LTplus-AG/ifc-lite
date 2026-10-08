/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Fixtures for IDSL-BSDD-001…003 on recorded bSDD responses (IDS-073). */

import { beforeAll, describe, expect, it } from 'vitest';
import { demoClass, demoProp, demoSource } from '../../../test/bsdd/replay.js';
import { docFromXml, entity, enumeration, idsXml, lintCode, runRuleFixtures, specXml, sv, type RuleFixtures } from '../../../test/lint-helpers.js';
import { checkUriHealth, createBsddUriIndex, type BsddUriIndex } from '../../bsdd/uri-health.js';
import { createLintContext } from '../context.js';
import { createLinter } from '../engine.js';
import type { LintContext } from '../types.js';

let ctx: LintContext;
let index: BsddUriIndex;
beforeAll(async () => {
  index = createBsddUriIndex();
  await checkUriHealth([demoClass('WAL'), demoClass('WAL-PRT'), demoClass('GONE'), demoProp('FireRating'), demoProp('Thickness')], { source: demoSource(), index, sleep: async () => {} });
  ctx = await createLintContext({ bsdd: index });
});

const wall = (req: string) => idsXml(specXml(entity('IFCWALL'), req));
const classification = (uri: string, value: string, system?: string) =>
  wall(`<classification uri="${uri}" cardinality="required"><value>${sv(value)}</value>${system === undefined ? '' : `<system>${system.startsWith('<') ? system : sv(system)}</system>`}</classification>`);
const prop = (uri: string, name: string, value?: string) =>
  wall(`<property uri="${uri}" dataType="IFCLABEL" cardinality="required"><propertySet>${sv('Demo_Wall')}</propertySet><baseName>${sv(name)}</baseName>${value ? `<value>${value}</value>` : ''}</property>`);

const FIXTURES: RuleFixtures[] = [
  {
    code: 'IDSL-BSDD-001',
    positive: [classification(demoClass('WAL-PRT'), 'WAL-PRT', 'Demo Elements'), prop(demoProp('Thickness'), 'Thickness'), classification(demoClass('GONE'), 'GONE', 'Demo Elements')],
    negative: [classification(demoClass('WAL'), 'WAL', 'Demo Elements'), classification(demoClass('NOT-CHECKED'), 'X', 'Demo Elements'), prop('https://example.org/prop/Thickness', 'Thickness')],
    fixes: 1,
  },
  {
    code: 'IDSL-BSDD-002',
    positive: [classification(demoClass('WAL'), 'WAL', 'Demo'), classification(demoClass('WAL'), 'WAL')],
    negative: [classification(demoClass('WAL'), 'WAL', 'Demo Elements'), classification(demoClass('WAL'), 'WAL', '<xs:restriction base="xs:string"><xs:pattern value="Demo.*"/></xs:restriction>'), classification(demoClass('NOT-CHECKED'), 'X', 'Other')],
    fixes: 1,
  },
  {
    code: 'IDSL-BSDD-003',
    positive: [prop(demoProp('FireRating'), 'FireRating', sv('EI120')), prop(demoProp('FireRating'), 'FireRating', enumeration(['EI60', 'EI120']))],
    negative: [prop(demoProp('FireRating'), 'FireRating', sv('EI60')), prop(demoProp('FireRating'), 'FireRating', sv('EI 60')), prop(demoProp('FireRating'), 'FireRating', enumeration(['EI30'])), prop(demoProp('FireRating'), 'FireRating')],
    fixes: 1,
  },
];

describe('IDSL-BSDD rules', () => {
  it.each(FIXTURES.map((f) => [f.code, f] as const))('%s fixtures', async (_code, f) => {
    await runRuleFixtures(ctx, f);
  });

  it('BSDD-001 points a deprecated classification at its replacement, code included', () => {
    const { diagnostics } = lintCode(ctx, 'IDSL-BSDD-001', classification(demoClass('WAL-PRT'), 'WAL-PRT', 'Demo Elements'));
    expect(diagnostics[0].message).toBe(`requirement 1: ${demoClass('WAL-PRT')} is inactive in bSDD; replaced by ${demoClass('WAL-INT')}`);
    expect(diagnostics[0].fixes?.[0].ops.map((o) => o.kind)).toEqual(['facet.setUri', 'value.set']);
  });

  it('BSDD-003 offers to keep the allowed values when some remain', () => {
    const { diagnostics } = lintCode(ctx, 'IDSL-BSDD-003', prop(demoProp('FireRating'), 'FireRating', enumeration(['EI60', 'EI120'])));
    expect(diagnostics[0].fixes?.map((f) => f.label)).toEqual(['Keep the allowed values', 'Use the bSDD values']);
  });

  it('finds nothing without a URI index (offline, nothing checked)', async () => {
    const plain = await createLintContext();
    for (const f of FIXTURES) for (const xml of f.positive) expect(lintCode(plain, f.code, xml).diagnostics).toEqual([]);
  });

  it('re-runs cached specs when URI health records new results', async () => {
    const live = createBsddUriIndex();
    const lctx = await createLintContext({ bsdd: live });
    const linter = createLinter(lctx, { rules: ['IDSL-BSDD-001'] });
    const doc = docFromXml(classification(demoClass('GONE'), 'GONE', 'Demo Elements'));
    expect(linter.lint(doc).diagnostics).toEqual([]);
    await checkUriHealth([demoClass('GONE')], { source: demoSource(), index: live, sleep: async () => {} });
    const after = linter.lint(doc);
    expect(after.stats.specsLinted).toBe(1);
    expect(after.diagnostics.map((d) => d.code)).toEqual(['IDSL-BSDD-001']);
  });
});

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Fixtures for IDSL-REGEX-* and the XSD pattern explainer (IDS-050). */

import { beforeAll, describe, expect, it } from 'vitest';
import { docFromXml, entity, idsXml, lintCode, pattern, property, runRuleFixtures, specXml, sv, type RuleFixtures } from '../../../test/lint-helpers.js';
import { createLintContext } from '../context.js';
import { createLinter } from '../engine.js';
import type { LintContext } from '../types.js';
import { explainXsdPattern, literalOf, tokenizeXsdPattern } from './xsd-regex.js';

let ctx: LintContext;
beforeAll(async () => {
  ctx = await createLintContext();
});

const wall = (req: string) => idsXml(specXml(entity('IFCWALL'), req));
const valuePattern = (p: string) => wall(property('Foo_Bar', 'Code', { value: pattern(p) }));
const psetPattern = (p: string) => wall(`<property><propertySet>${pattern(p)}</propertySet><baseName>${sv('Code')}</baseName></property>`);

const FIXTURES: RuleFixtures[] = [
  {
    code: 'IDSL-REGEX-001',
    positive: [valuePattern('^EI[0-9]+$'), valuePattern('^EI.*'), valuePattern('A$B')],
    negative: [valuePattern('EI[0-9]+'), valuePattern('[^A]+'), valuePattern('EI\\^')],
    fixes: 1,
  },
  {
    code: 'IDSL-REGEX-002',
    positive: [valuePattern('EI60'), valuePattern('.*'), valuePattern('Fire\\.Rating')],
    negative: [valuePattern('.*EI.*'), valuePattern('42'), psetPattern('.*')],
    fixes: 1,
  },
  {
    code: 'IDSL-REGEX-003',
    positive: [valuePattern('(?:EI|REI)[0-9]+'), valuePattern('(?=A)B'), valuePattern('EI\\b'), valuePattern('[0-9]+\\/[0-9]+')],
    negative: [valuePattern('(EI|REI)[0-9]+'), valuePattern('\\d+'), valuePattern('[(?]x')],
    fixes: 1,
  },
  {
    code: 'IDSL-REGEX-004',
    positive: [valuePattern('(a+)+b'), valuePattern('(\\d+)*x')],
    negative: [valuePattern('a+b'), valuePattern('[A-Z]{2}[0-9]{3}')],
  },
];

describe('pattern rules', () => {
  for (const f of FIXTURES) it(f.code, () => runRuleFixtures(ctx, f));

  it('REGEX-003 is info for constructs the reference tools accept, warning otherwise', () => {
    const sev = (p: string) => lintCode(ctx, 'IDSL-REGEX-003', valuePattern(p)).diagnostics.map((d) => d.severity);
    expect(sev('(?:A|B)')).toEqual(['info']);
    expect(sev('[0-9]+\\/[0-9]+')).toEqual(['info']);
    expect(sev('(?=A)B')).toEqual(['warning']);
    expect(sev('A+?')).toEqual(['warning']);
  });

  it('a caller severity override wins over per-finding demotion', () => {
    const r = createLinter(ctx, { rules: ['IDSL-REGEX-003'], severity: { 'IDSL-REGEX-003': 'error' } }).lint(docFromXml(valuePattern('(?:A|B)')));
    expect(r.diagnostics.map((d) => d.severity)).toEqual(['error']);
  });
});

describe('XSD pattern explainer', () => {
  it('tokenizes classes, escapes, groups and quantifiers', () => {
    expect(tokenizeXsdPattern('[^a\\]]+(x|\\d){2,3}?').map((t) => `${t.kind}:${t.text}`)).toEqual([
      'class:[^a\\]]',
      'quantifier:+',
      'open:(',
      'char:x',
      'alt:|',
      'classEscape:\\d',
      'close:)',
      'quantifier:{2,3}',
      'lazy:?',
    ]);
  });

  it('explains anchors as literals and lists unsupported constructs', () => {
    const e = explainXsdPattern('^\\w+(?=x)$');
    expect(e.anchored).toBe(true);
    expect(e.parts[0].meaning).toMatch(/literal character "\^"/);
    expect(e.parts[1].meaning).toMatch(/no underscore/);
    expect(e.unsupported).toEqual(['(?=']);
  });

  it('recognises plain literals', () => {
    expect(literalOf('Fire\\.Rating')).toBe('Fire.Rating');
    expect(literalOf('EI[0-9]')).toBeUndefined();
    expect(literalOf('\\p{L}')).toBeUndefined();
  });
});

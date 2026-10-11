/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeAll, describe, expect, it } from 'vitest';
import { docFromXml, entity, idsXml, property, specXml } from '../../test/lint-helpers.js';
import { createLintContext } from './context.js';
import { createLinter } from './engine.js';
import { LINT_RULES } from './rules/index.js';
import type { LintContext } from './types.js';

let ctx: LintContext;
beforeAll(async () => {
  ctx = await createLintContext();
});

const OPT_IN = ['IDSL-ENT-003', 'IDSL-SPEC-008'];

// IfcWall in IFC4 has concrete subtypes (ENT-003) and the spec has no
// description or instructions (SPEC-008): both opt-in rules would fire.
const doc = () => docFromXml(idsXml(specXml(entity('IFCWALL'), property('Pset_WallCommon', 'IsExternal'), 'ifcVersion="IFC4"', 'Walls')));
const codes = (options: Parameters<typeof createLinter>[1]) => createLinter(ctx, options).lint(doc()).diagnostics.map((d) => d.code);

describe('opt-in rules (#7144)', () => {
  it('are exactly ENT-003 and SPEC-008; CARD-001 stays an on-by-default warning', () => {
    expect(LINT_RULES.filter((r) => r.optIn).map((r) => r.code)).toEqual(OPT_IN);
    const card = LINT_RULES.find((r) => r.code === 'IDSL-CARD-001')!;
    expect(card.defaultSeverity).toBe('warning');
    expect(card.optIn).toBeUndefined();
  });

  it('are off by default', () => {
    const active = createLinter(ctx).rules.map((r) => r.code);
    for (const code of OPT_IN) expect(active).not.toContain(code);
    expect(active).toContain('IDSL-CARD-001');
    const found = codes(undefined);
    for (const code of OPT_IN) expect(found).not.toContain(code);
  });

  it('are enabled by a severity in the config, at that severity', () => {
    const linter = createLinter(ctx, { severity: { 'IDSL-ENT-003': 'info', 'IDSL-SPEC-008': 'warning' } });
    expect(linter.rules.map((r) => r.code)).toEqual(expect.arrayContaining(OPT_IN));
    const diagnostics = linter.lint(doc()).diagnostics;
    expect(diagnostics.find((d) => d.code === 'IDSL-ENT-003')?.severity).toBe('info');
    expect(diagnostics.find((d) => d.code === 'IDSL-SPEC-008')?.severity).toBe('warning');
  });

  it('are enabled by naming them in rules, and "off" still wins', () => {
    expect(codes({ rules: OPT_IN }).sort()).toEqual(OPT_IN);
    expect(codes({ rules: OPT_IN, severity: { 'IDSL-SPEC-008': 'off' } })).toEqual(['IDSL-ENT-003']);
    expect(codes({ severity: { 'IDSL-SPEC-008': 'off' } })).not.toContain('IDSL-SPEC-008');
  });
});

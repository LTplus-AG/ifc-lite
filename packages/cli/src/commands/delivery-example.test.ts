/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Acceptance evidence for issue #3931: the COMMITTED example recipe under
 * `examples/delivery/` runs against real, catalogued IFC/IDS/rules fixtures
 * (checked into the repo, no `pnpm fixtures` fetch needed) and exercises all
 * three outcomes the issue's acceptance criteria call for in one recipe:
 * a passing model, a structurally-failing model, and an unreadable model —
 * plus an IDS specification that fails and a `.rules.json` rule set that
 * PASSES against the clean model (#5138 PR 7b), proving "consolidated ...
 * output" actually asserts against the underlying structural/IDS/rules
 * results rather than just echoing them.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { deliveryCommand } from './delivery.js';

const here = dirname(fileURLToPath(import.meta.url));
const RECIPE = resolve(here, '../../examples/delivery/recipe.json');

function silenceOutput() {
  return vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});

describe('committed example recipe (examples/delivery/recipe.json)', () => {
  it('reports pass/fail/error across its three models plus an IDS failure, with an overall FAIL verdict', async () => {
    const write = silenceOutput();
    await deliveryCommand([RECIPE, '--json']);
    const report = JSON.parse(write.mock.calls.map(c => String(c[0])).join('')) as {
      verdict: string;
      models: Array<{ path: string; loadError?: string; sha256?: string }>;
      checks: Array<{ model: string; type: string; status: string }>;
    };

    expect(report.verdict).toBe('fail'); // never a successful verdict: one model is unreadable and one IDS spec fails

    const byModel = (m: string) => report.checks.filter(c => c.model === m);

    // clean-model.ifc: structural passes; it lacks a Tag so the IDS check
    // fails, but it IS named, so the rules check (#5138 PR 7b) passes —
    // proving the three check types are genuinely independent, not one
    // engine's verdict echoed three ways.
    expect(byModel('clean-model.ifc').find(c => c.type === 'structural')?.status).toBe('pass');
    expect(byModel('clean-model.ifc').find(c => c.type === 'ids')?.status).toBe('fail');
    expect(byModel('clean-model.ifc').find(c => c.type === 'rules')?.status).toBe('pass');

    // incomplete-model.ifc: missing IfcSite/IfcBuilding -> structural fail.
    expect(byModel('incomplete-model.ifc').find(c => c.type === 'structural')?.status).toBe('fail');

    // missing-model.ifc: declared in the recipe but never committed -> every
    // check for it is `error`, never silently dropped and never `pass`.
    const missingModel = report.models.find(m => m.path === 'missing-model.ifc');
    expect(missingModel?.loadError).toBeTruthy();
    expect(missingModel?.sha256).toBeUndefined();
    expect(byModel('missing-model.ifc')).toHaveLength(3); // structural + ids + rules, all `error`
    expect(byModel('missing-model.ifc').every(c => c.status === 'error')).toBe(true);
  });
});

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Two paths that must agree" coverage: the `cost-report` script template
 * (executed inside the QuickJS sandbox, which has no module resolution of
 * its own) must classify the exact same diagnostic codes as "cyclic" that
 * the Cost panel's `classifyCostModel` does — see cost-tree.ts's
 * `CYCLE_CODES_LIST` and templates.ts's `injectCycleCodes`. Without this
 * test, a code added to one list but not the other (e.g. a model with
 * only a QUANTITY_CYCLE or VALUE_CYCLE diagnostic) would show the panel's
 * cyclic badge but print no cycle warning from the template — silently.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SCRIPT_TEMPLATES } from './templates.js';
import { CYCLE_CODES_LIST } from '../cost/cost-tree.js';

describe('cost-report template — cycle codes stay in sync with the Cost panel', () => {
  it('the injected cycleCodes literal is exactly CYCLE_CODES_LIST (fixture can fail: a stale template would still say NESTING_CYCLE only)', () => {
    const template = SCRIPT_TEMPLATES.find((t) => t.name === 'Cost report (5D)');
    assert.ok(template, 'Cost report (5D) template must exist');
    const match = template.code.match(/const cycleCodes: string\[\] = (\[[^\]]*\])/);
    assert.ok(match, 'cost-report template must declare a cycleCodes literal');
    const injected = JSON.parse(match[1]);
    assert.deepEqual(injected, CYCLE_CODES_LIST);

    // Every code cost-tree.ts treats as cyclic must appear — not just
    // NESTING_CYCLE — so QUANTITY_CYCLE / VALUE_CYCLE-only models still get
    // the template's cycle warning.
    assert.equal(CYCLE_CODES_LIST.includes('QUANTITY_CYCLE'), true);
    assert.equal(CYCLE_CODES_LIST.includes('VALUE_CYCLE'), true);
    for (const code of CYCLE_CODES_LIST) {
      assert.equal(injected.includes(code), true, `template must include ${code}`);
    }
  });
});

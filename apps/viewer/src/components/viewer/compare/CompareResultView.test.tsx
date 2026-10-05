/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The comparison on the shared ResultView (U02, #6925), over a diff computed
 * by the real engine (`saved-comparison-fixture`): the source line names both
 * revisions, the scope and the compared population; coverage is partial,
 * with the reason, when geometry changes could not be detected.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, render } from '@/test/render.js';
import { comparisonResult } from '@/test/saved-comparison-fixture';
import { CompareResultView } from './CompareResultView';

afterEach(cleanup);

const text = (root: ParentNode) => root.textContent?.replace(/\s+/g, ' ') ?? '';

function mount(overrides: Partial<ReturnType<typeof comparisonResult>> = {}) {
  const result = { ...comparisonResult('A', 'B'), ...overrides };
  return render(<CompareResultView result={result} split={null} matchedElements={null} exportBar={<p>EXPORT</p>} list={<p>LIST</p>} detail={null} />);
}

describe('comparison result view (U02, #6925)', () => {
  it('names both revisions, the scope and the engine counts', () => {
    const ui = mount();
    const region = ui.querySelector('section[aria-label="Compare models results"]');
    assert.ok(region);
    // A → B: wall modified, `removed` deleted, `new` added; nothing unchanged.
    assert.match(text(region), /Comparison · Data scope.*Models \(2\): A, B.*3 elements compared/);
    assert.match(text(region), /Complete.*3 changed · 0 unchanged/);
    assert.equal(region.querySelector('ul[aria-label="Incomplete"]'), null);
    assert.match(text(region), /EXPORT.*LIST/);
  });

  it('is partial, saying why, when geometry changes cannot be detected', () => {
    const ui = mount({ scope: 'both', geometryUnavailable: true });
    assert.match(text(ui), /Partial/);
    assert.match(text(ui.querySelector('ul[aria-label="Incomplete"]')!), /Geometry changes are not detected/);
  });

  it('a data-only comparison never claims a geometry gap', () => {
    const ui = mount({ scope: 'data', geometryUnavailable: true });
    assert.match(text(ui), /Complete/);
  });
});

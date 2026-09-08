/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The zone label's pill must contain its own text.
 *
 * The bug: the width came from `zone.name.length` while the label renders
 * "{set name} / {zone name}", so the dark background stopped short and the text
 * ran out of it - worst for a short zone name under a long set name, where the
 * pill was a stub behind a full-width label.
 *
 * A test DOM implements no SVG layout, so `getBBox` is absent and the component
 * falls back to its character estimate. That is exactly the path worth pinning
 * here: the estimate is what the first paint uses, and it is where the bug was.
 * The MEASURED path is verified in a real browser, where the pill came back
 * with 6px of padding either side at both 162px and 334px of text.
 */

import '@/test/setup-dom.js';
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup } from '@/test/render.js';
import { ZoneLabel } from './ZoneOverlay.js';

after(cleanup);

function pillWidth(text: string): number {
  const container = render(<svg><ZoneLabel text={text} /></svg>);
  const rect = container.querySelector('rect');
  assert.ok(rect, 'the label rendered no pill');
  return Number(rect.getAttribute('width'));
}

describe('ZoneLabel', () => {
  it('widens with the SET name, not only the zone name', () => {
    // The reported bug, stated as the property that was false: two labels whose
    // zone names are identical but whose set names differ must not share a
    // pill width.
    const short = pillWidth('S / A');
    const long = pillWidth('Bauabschnitt Erschliessung / A');
    assert.ok(
      long > short * 3,
      `the pill ignored the set name: "${long}" for a 30-character label vs "${short}" for a 5-character one`,
    );
  });

  it('widens with the zone name too', () => {
    const short = pillWidth('Takt / A');
    const long = pillWidth('Takt / Wohnungstrennwand Nordfassade');
    assert.ok(long > short, 'the pill ignored the zone name');
  });

  it('leaves room for the text on both sides', () => {
    // The pill starts 2px left of the origin and the text 6px right of that, so
    // a width that only covered the glyphs would clip the right edge.
    const text = 'Takt / Wohnungstrennwand';
    const container = render(<svg><ZoneLabel text={text} /></svg>);
    const rect = container.querySelector('rect');
    const label = container.querySelector('text');
    assert.ok(rect && label);
    const padding = Number(label.getAttribute('x')) - Number(rect.getAttribute('x'));
    assert.equal(padding, 6);
    // ...and the same padding is present on the right of the estimate.
    assert.ok(Number(rect.getAttribute('width')) >= text.length * 6.2 + padding * 2);
  });

  it('renders the pill BEFORE the text, so it cannot cover it', () => {
    const container = render(<svg><ZoneLabel text="Takt / A" /></svg>);
    const children = [...(container.querySelector('svg')?.children ?? [])].map((c) => c.tagName);
    assert.deepEqual(children, ['rect', 'text']);
  });
});

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6233: the Space Sketch plan card read "0 rooms · 0.0 cm²" while the status
 * line reported areas in m². Both now use `formatSquareMetres`; the empty
 * draft reads "0.0 m²". Mounted with no model loaded, the tool's default
 * render (see `SpaceSketch.i18n.test.tsx` for why no rooms can be derived
 * under node).
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, render } from '@/test/render.js';
import { ViewportHud } from '../../viewport-ui/hud/ViewportHud.js';
import { SpaceSketchOverlay } from './SpaceSketchOverlay.js';
import { formatSquareMetres } from './computePolygonArea.js';

afterEach(cleanup);

describe('Space Sketch area unit (#6233)', () => {
  it('shows the empty draft area in m², never cm²', () => {
    render(<><ViewportHud /><SpaceSketchOverlay /></>);
    const text = document.body.textContent ?? '';
    assert.match(text, /0 rooms · 0\.0 m²/);
    assert.doesNotMatch(text, /cm²/);
    assert.match(text, /Pick a storey to derive rooms from its walls\./);
  });

  it('formats every size in m², one decimal', () => {
    assert.equal(formatSquareMetres(0), '0.0 m²');
    assert.equal(formatSquareMetres(0.004), '0.0 m²');
    assert.equal(formatSquareMetres(12.34), '12.3 m²');
    assert.equal(formatSquareMetres(25000), '25000.0 m²');
  });
});

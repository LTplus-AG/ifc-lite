/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Measure overlay colours come from the overlay tokens (#5490). The snap
 * indicator used a Material hue per snap kind (yellow vertex, orange edge,
 * light-blue face, cyan face centre, violet point cloud) and the vertex and
 * point-cloud kinds differed ONLY by hue. Now every kind is drawn in the one
 * accent and told apart by its glyph; finished measurements are ink.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SnapType } from '@ifc-lite/renderer';
import { render, cleanup } from '@/test/render.js';
import { overlayColor } from '@/lib/viewport-ui/overlay-theme';
import { MeasurementOverlays, type MeasurementOverlaysProps } from './MeasurementVisuals.js';

afterEach(cleanup);

const ACCENT = overlayColor('overlay-accent');
const INK = overlayColor('overlay-ink');

const BASE: MeasurementOverlaysProps = {
  measurements: [],
  pending: null,
  activeMeasurement: null,
  snapTarget: null,
  snapVisualization: null,
};

/** Every colour an SVG subtree paints with: fill / stroke attributes, `none` excluded. */
function paintColours(root: Element): Set<string> {
  const colours = new Set<string>();
  for (const el of [root, ...root.querySelectorAll('*')]) {
    for (const attr of ['fill', 'stroke']) {
      const value = el.getAttribute(attr);
      if (value && value !== 'none') colours.add(value);
    }
  }
  return colours;
}

/** Glyph geometry with the kind-independent outer glow ring dropped. */
function glyphShape(svg: Element): string {
  return [...svg.children]
    .slice(1)
    .map((el) => el.outerHTML)
    .join('');
}

describe('measure snap indicator (#5490)', () => {
  const kinds = Object.values(SnapType);
  const rendered = kinds.map((kind) => {
    const container = render(
      <MeasurementOverlays
        {...BASE}
        snapTarget={{ type: kind, position: { x: 0, y: 0, z: 0 } } as MeasurementOverlaysProps['snapTarget']}
        hoverPosition={{ x: 50, y: 60 }}
      />,
    );
    const svg = container.querySelector(`svg[data-snap-kind="${kind}"]`);
    assert.ok(svg, `a ${kind} snap renders an indicator`);
    return { kind, svg };
  });

  it('draws every snap kind in the one accent, no per-kind hue', () => {
    for (const { kind, svg } of rendered) {
      assert.deepEqual([...paintColours(svg)], [ACCENT], `${kind} paints only with the accent`);
    }
  });

  it('gives every snap kind its own glyph, so shape alone tells them apart', () => {
    const shapes = rendered.map(({ svg }) => glyphShape(svg));
    assert.equal(new Set(shapes).size, kinds.length, 'no two snap kinds share a glyph (vertex vs point cloud included)');
  });
});

describe('measure lines (#5490)', () => {
  const point = (x: number, y: number) => ({ x, y, z: 0, screenX: x, screenY: y });

  it('a finished measurement is ink; a live one is the accent', () => {
    const finished = render(
      <MeasurementOverlays {...BASE} measurements={[{ id: 'm1', start: point(0, 0), end: point(10, 0), distance: 10 } as MeasurementOverlaysProps['measurements'][number]]} />,
    );
    const finishedLine = finished.querySelector('line');
    assert.ok(finishedLine);
    assert.equal(finishedLine.getAttribute('stroke'), INK);

    const live = render(
      <MeasurementOverlays {...BASE} activeMeasurement={{ start: point(0, 0), current: point(10, 0), distance: 10 }} />,
    );
    const liveLine = live.querySelector('line');
    assert.ok(liveLine);
    assert.equal(liveLine.getAttribute('stroke'), ACCENT);
  });
});

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * SVG scene primitives (#5486): render with token classes, project onto
 * the stub camera, and hide when the anchor is behind the camera or
 * unregistered. Mutation-checked: each assertion was verified to fail
 * when the guarded behaviour was reverted (see the comment above each).
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, useState } from 'react';
import { cleanup } from '@/test/render.js';
import { renderScene } from '../test/scene-test-support.js';
import { Handle } from './Handle.js';
import { AxisArrow } from './AxisArrow.js';
import { SnapGlyph } from './SnapGlyph.js';
import { Pin } from './Pin.js';
import { PlaneOutline } from './PlaneOutline.js';
import { Leader } from './Leader.js';
import type { Vec3 } from '../types.js';

afterEach(() => cleanup());

describe('Handle', () => {
  it('is hidden until the projector ticks, then projects and carries the accent class when active', () => {
    const { container, flush } = renderScene(<Handle worldPoint={{ x: 10, y: 20, z: 0 }} active title="drag" />);
    const g = container.querySelector('[data-scene-primitive="handle"]') as SVGGElement;
    assert.ok(g);
    assert.equal(g.style.display, 'none', 'nothing has projected yet');
    flush();
    assert.equal(g.style.display, '', 'a dirty tick reveals it');
    assert.equal(g.style.transform, 'translate(10px, 20px)');
    const circle = g.querySelector('circle')!;
    assert.match(circle.getAttribute('class') ?? '', /fill-overlay-accent/, 'active handles use the one accent token');
    // Mutation check: swapping `active ? 'fill-overlay-accent' : 'fill-overlay-ink'`
    // for a hardcoded class would still pass `display` assertions but fail this one.
  });

  it('is passive (ink) when not active', () => {
    const { container, flush } = renderScene(<Handle worldPoint={{ x: 1, y: 1, z: 0 }} />);
    flush();
    const circle = container.querySelector('[data-scene-primitive="handle"] circle')!;
    assert.match(circle.getAttribute('class') ?? '', /fill-overlay-ink\b/);
  });

  it('hides again once its world point projects behind the camera', () => {
    const { container, source, flush } = renderScene(<Handle worldPoint={{ x: 1, y: 1, z: 0 }} />);
    flush();
    const g = container.querySelector('[data-scene-primitive="handle"]') as SVGGElement;
    assert.equal(g.style.display, '');
    source.camera.behind = true;
    source.dirty = true;
    flush();
    assert.equal(g.style.display, 'none');
    // Mutation check: dropping the `else { el.style.display = 'none' }` branch
    // in useWorldAnchor's callback would leave this asserting a false positive.
  });

  it('hides when off-screen, even though projection.screen is truthy (#5636 review)', () => {
    // The stub camera maps world x/y straight to screen px with no clamping,
    // so a world point of (5000, 5000) against the default 800x600 stub
    // canvas projects to a real, truthy `screen` point that is nonetheless
    // outside the canvas — `offScreen: true`. `useWorldAnchor` must treat
    // that the same as "no screen".
    const { container, flush } = renderScene(<Handle worldPoint={{ x: 5000, y: 5000, z: 0 }} />);
    flush();
    const g = container.querySelector('[data-scene-primitive="handle"]') as SVGGElement;
    assert.equal(g.style.display, 'none');
    // Mutation check: `if (projection.screen)` without the `&& !projection.offScreen`
    // clause reads `display: ''` here instead — verified by reverting the
    // fix and re-running this file (see PR #5636 review thread).
  });

  it('re-projects when worldPoint changes VALUE with a static camera (#5636 review)', () => {
    // Registration only happens once (on mount); with a static camera
    // nothing else re-checks a static-looking anchor. A prop-driven
    // worldPoint move must itself wake the projector.
    let setPoint!: (p: Vec3) => void;
    function Harness() {
      const [point, setP] = useState<Vec3>({ x: 1, y: 1, z: 0 });
      setPoint = setP;
      return <Handle worldPoint={point} />;
    }
    const { container, source, flush } = renderScene(<Harness />);
    flush();
    const g = container.querySelector('[data-scene-primitive="handle"]') as SVGGElement;
    assert.equal(g.style.transform, 'translate(1px, 1px)');
    source.dirty = false; // camera stays put — only the worldPoint prop moves
    act(() => setPoint({ x: 9, y: 9, z: 0 }));
    flush();
    assert.equal(g.style.transform, 'translate(9px, 9px)');
    // Mutation check: removing the `useEffect(() => projector?.notifyAnchorsChanged(), [projector, currentWorldPoint?.x, …])`
    // effect leaves `scheduler.pending` at 0 after the prop change, so `flush()`
    // runs nothing and this reads the stale `translate(1px, 1px)`.
  });
});

describe('SnapGlyph', () => {
  it('renders the glow filter and the accent fill for its kind', () => {
    const { container, flush } = renderScene(<SnapGlyph worldPoint={{ x: 3, y: 4, z: 0 }} kind="midpoint" />);
    flush();
    const g = container.querySelector('[data-scene-primitive="snap-glyph"]') as SVGGElement;
    assert.equal(g.style.display, '');
    assert.equal(g.getAttribute('data-snap-kind'), 'midpoint');
    const shapeGroup = g.querySelector('g')!;
    assert.match(shapeGroup.getAttribute('class') ?? '', /fill-overlay-accent/);
    assert.match(shapeGroup.getAttribute('filter') ?? '', /url\(#scene-overlay-glow\)/);
  });
});

describe('Pin', () => {
  it('uses a status token when a status is given, ignoring active', () => {
    const { container, flush } = renderScene(<Pin worldPoint={{ x: 0, y: 0, z: 0 }} active status="danger" />);
    flush();
    const path = container.querySelector('[data-scene-primitive="pin"] path')!;
    assert.match(path.getAttribute('class') ?? '', /fill-status-danger/);
  });

  it('falls back to ink/accent when no status is given', () => {
    const { container, flush } = renderScene(<Pin worldPoint={{ x: 0, y: 0, z: 0 }} />);
    flush();
    const path = container.querySelector('[data-scene-primitive="pin"] path')!;
    assert.match(path.getAttribute('class') ?? '', /fill-overlay-ink\b/);
  });
});

describe('AxisArrow', () => {
  it('draws a line from foot to a point lengthPx along the foot->tip screen direction', () => {
    const { container, flush } = renderScene(
      <AxisArrow foot={{ x: 0, y: 0, z: 0 }} tip={{ x: 10, y: 0, z: 0 }} lengthPx={50} variant="axis-x" />,
    );
    flush();
    const line = container.querySelector('[data-scene-primitive="axis-arrow"]') as SVGLineElement;
    assert.equal(line.style.display, '');
    assert.equal(line.getAttribute('x1'), '0');
    assert.equal(line.getAttribute('y1'), '0');
    // Stub camera maps world x/y straight to screen px, so foot->tip direction is +x; length is pinned to `lengthPx`, not the 10px world distance.
    assert.equal(line.getAttribute('x2'), '50');
    assert.equal(line.getAttribute('y2'), '0');
    assert.match(line.getAttribute('class') ?? '', /stroke-axis-x/);
    // Mutation check: using the world-space foot->tip distance instead of a
    // normalized direction would make x2 read "10", not "50".
  });

  it('stays hidden if either endpoint cannot project', () => {
    const { container, flush } = renderScene(<AxisArrow foot={{ x: 0, y: 0, z: 0 }} tip={null} />);
    flush();
    const line = container.querySelector('[data-scene-primitive="axis-arrow"]') as SVGLineElement;
    assert.equal(line.style.display, 'none');
  });
});

describe('PlaneOutline', () => {
  it('builds the polygon points from all corners once every corner has projected', () => {
    const corners = [
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 },
      { x: 10, y: 10, z: 0 },
      { x: 0, y: 10, z: 0 },
    ];
    const { container, flush } = renderScene(<PlaneOutline corners={corners} />);
    flush();
    const polygon = container.querySelector('[data-scene-primitive="plane-outline"]') as SVGPolygonElement;
    assert.equal(polygon.style.display, '');
    assert.equal(polygon.getAttribute('points'), '0,0 10,0 10,10 0,10');
    assert.match(polygon.getAttribute('class') ?? '', /fill-overlay-accent-soft/);
    assert.match(polygon.getAttribute('class') ?? '', /stroke-overlay-accent/);
  });

  it('hides entirely if even one corner is behind the camera', () => {
    const corners = [
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 },
      { x: 10, y: 10, z: 0 },
    ];
    const { container, source, flush } = renderScene(<PlaneOutline corners={corners} />);
    flush();
    const polygon = container.querySelector('[data-scene-primitive="plane-outline"]') as SVGPolygonElement;
    assert.equal(polygon.style.display, '');
    source.camera.behind = true;
    source.dirty = true;
    flush();
    assert.equal(polygon.style.display, 'none');
    // Mutation check: using `.some()` instead of `.every()` for `allVisible`
    // would keep the polygon visible with a missing corner.
  });

  it('re-projects when corner VALUES change without corners.length changing (#5636 review)', () => {
    let setCorners!: (c: Vec3[]) => void;
    function Harness() {
      const [corners, setC] = useState<Vec3[]>([
        { x: 0, y: 0, z: 0 },
        { x: 10, y: 0, z: 0 },
        { x: 10, y: 10, z: 0 },
      ]);
      setCorners = setC;
      return <PlaneOutline corners={corners} />;
    }
    const { container, source, flush } = renderScene(<Harness />);
    flush();
    const polygon = container.querySelector('[data-scene-primitive="plane-outline"]') as SVGPolygonElement;
    assert.equal(polygon.getAttribute('points'), '0,0 10,0 10,10');
    source.dirty = false; // camera stays put — only the corner coordinates move
    act(() =>
      setCorners([
        { x: 5, y: 5, z: 0 },
        { x: 15, y: 5, z: 0 },
        { x: 15, y: 15, z: 0 },
      ]),
    );
    flush();
    assert.equal(polygon.getAttribute('points'), '5,5 15,5 15,15');
    // Mutation check: removing the `cornerKey`-driven `useEffect` leaves the
    // main registration effect's `[projector, baseId, corners.length]` deps
    // unchanged (length is still 3), so no frame gets scheduled and this
    // reads the stale `0,0 10,0 10,10`.
  });
});

describe('Leader', () => {
  it('draws from the anchor to anchor+offset', () => {
    const { container, flush } = renderScene(<Leader worldPoint={{ x: 5, y: 5, z: 0 }} offset={{ dx: 20, dy: -10 }} />);
    flush();
    const line = container.querySelector('[data-scene-primitive="leader"]') as SVGLineElement;
    assert.equal(line.style.display, '');
    assert.equal(line.getAttribute('x1'), '5');
    assert.equal(line.getAttribute('y1'), '5');
    assert.equal(line.getAttribute('x2'), '25');
    assert.equal(line.getAttribute('y2'), '-5');
    assert.match(line.getAttribute('class') ?? '', /stroke-overlay-ink-muted/, 'passive by default');
  });

  it('switches to the accent token and drops the dash when active', () => {
    const { container, flush } = renderScene(<Leader worldPoint={{ x: 0, y: 0, z: 0 }} offset={{ dx: 1, dy: 1 }} active />);
    flush();
    const line = container.querySelector('[data-scene-primitive="leader"]')!;
    assert.match(line.getAttribute('class') ?? '', /stroke-overlay-accent/);
    assert.equal(line.getAttribute('stroke-dasharray'), null);
  });
});

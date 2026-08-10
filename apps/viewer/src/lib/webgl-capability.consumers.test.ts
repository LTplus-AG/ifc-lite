/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One latch per consumer, or one shared latch? (#2401 review)
 *
 * The proposal was to share a single verdict across the MapLibre minimap and
 * the three.js surfaces, on the reasoning that WebGL2 support is a property of
 * the device and cannot differ between them — so a second probe and a second
 * handled report for one underlying cause is waste.
 *
 * The premise is what fails, and these tests are the evidence. The two
 * consumers do not ask the same question:
 *
 *   MapLibre  stencil: true,  antialias: false
 *   three.js  stencil: false, antialias: true
 *
 * Those are exactly the two axes a constrained device refuses on, and the
 * failure that put this whole gate in the repo was a STENCIL failure —
 * `OES_packed_depth_stencil support is required.` on an ANGLE/D3D11 path (see
 * `lib/geo/map-webgl-support.ts`). A device that cannot back MapLibre's
 * depth+stencil request can still serve three.js, which asks for no stencil at
 * all. Sharing one verdict would take that device's working `/mcp` hero away
 * on the strength of an unrelated minimap failure.
 *
 * Both surfaces really can be reached in one document, so this is not
 * theoretical: `KeyboardShortcutsDialog` navigates `/` -> `/mcp` through
 * `navigateToPath`, which is a `pushState` plus a synthetic `popstate`. No
 * reload, so module state — and therefore both gates — survives the trip.
 *
 * Everything below drives the PRODUCTION entry points (`probeMapWebglSupport`,
 * `startThreeScene`) and counts real `document.createElement('canvas')` calls,
 * so the probe count is measured rather than asserted from the source.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  probeMapWebglSupport,
  takeMapWebglReportSlot,
  resetMapWebglSupportForTests,
} from './geo/map-webgl-support.js';
import {
  startThreeScene,
  takeThreeWebglReportSlot,
  resetThreeWebglSupportForTests,
} from '../components/mcp/three-webgl-support.js';

/** Stands in for the container React would hand the scene factory. */
const CONTAINER = {} as HTMLElement;
const HANDLE = { dispose: () => undefined };

const realCreateElement = document.createElement.bind(document);

/**
 * Serve `webgl2` unless the caller asks for something this device refuses.
 *
 * Modelled on a real driver, not an abstract "no WebGL" switch: the device
 * answers differently depending on the attributes, which is the whole point at
 * issue. Returns the number of canvases handed out, i.e. the probe count.
 */
function installDevice(refuses: (attrs: Record<string, unknown>) => boolean): () => number {
  let canvases = 0;
  document.createElement = ((tag: string, options?: ElementCreationOptions) => {
    if (String(tag).toLowerCase() !== 'canvas') return realCreateElement(tag, options);
    canvases += 1;
    return {
      getContext(type: string, attrs?: unknown) {
        if (type !== 'webgl2') return null;
        if (refuses((attrs ?? {}) as Record<string, unknown>)) return null;
        return { getExtension: () => ({ loseContext: () => undefined }) };
      },
    } as unknown as HTMLCanvasElement;
  }) as typeof document.createElement;
  return () => canvases;
}

beforeEach(() => {
  resetMapWebglSupportForTests();
  resetThreeWebglSupportForTests();
});

afterEach(() => {
  document.createElement = realCreateElement;
});

describe('the two WebGL consumers in one SPA session (#2401)', () => {
  it('costs a GPU-less user exactly one probe and one report per surface', () => {
    // The measurement the design argument turns on. A device with no `webgl2`
    // at all, visiting the viewer and then `/mcp` without a reload.
    const canvases = installDevice(() => true);

    assert.equal(probeMapWebglSupport().supported, false);
    const three = startThreeScene(CONTAINER, () => HANDLE);
    assert.equal(three.ok, false);

    assert.equal(canvases(), 2, 'one probe per consumer, not per mount');
    // Both are cheap and released: a probe that leaked would be the thing that
    // eventually causes a refusal, since a page gets ~16 live contexts.
    assert.equal(takeMapWebglReportSlot(), true);
    assert.equal(takeThreeWebglReportSlot(), true);
    assert.equal(takeMapWebglReportSlot(), false, 'the map reports once per session');
    assert.equal(takeThreeWebglReportSlot(), false, 'three reports once per session');
  });

  it('re-visiting either surface adds no further probes', () => {
    // The cost above is per session, not per navigation: the latches absorb
    // every subsequent mount, which is what makes 2 the ceiling rather than a
    // number that grows as the user moves around.
    const canvases = installDevice(() => true);

    probeMapWebglSupport();
    startThreeScene(CONTAINER, () => HANDLE);
    probeMapWebglSupport();
    startThreeScene(CONTAINER, () => HANDLE);
    startThreeScene(CONTAINER, () => HANDLE);

    assert.equal(canvases(), 2, 'the latches must absorb every later visit');
  });

  it('does NOT let a stencil-refusing device take away a working /mcp hero', () => {
    // The production failure, exactly: MapLibre asks for depth+stencil and is
    // refused; three.js asks for no stencil and is fine. One shared verdict
    // would degrade the hero here for no reason.
    installDevice((attrs) => attrs.stencil === true);

    assert.deepEqual(probeMapWebglSupport(), { supported: false, reason: 'probe_no_context' });

    const three = startThreeScene(CONTAINER, () => HANDLE);
    assert.equal(three.ok, true, 'three.js must still run: it never asked for a stencil buffer');
    assert.equal(takeThreeWebglReportSlot(), true, 'and three must not have consumed a report for a map failure');
  });

  it('does NOT let an antialias-refusing device take away a working minimap', () => {
    // The mirror image, so the isolation is shown to cut both ways rather than
    // happening to favour one consumer.
    installDevice((attrs) => attrs.antialias === true);

    const three = startThreeScene(CONTAINER, () => HANDLE);
    assert.equal(three.ok, false, 'three.js asked for MSAA and was refused');

    assert.deepEqual(probeMapWebglSupport(), { supported: true }, 'the map never asked for MSAA');
  });
});

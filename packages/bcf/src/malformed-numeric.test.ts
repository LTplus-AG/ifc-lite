/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A `.bcfzip` is an untrusted file and every number in it arrives through a
 * bare `parseFloat`, which has no out-of-band failure value: `"NaN"` parses to
 * `NaN` and the perfectly well-formed decimal literal `"1e999"` parses to
 * `Infinity`. Those flow through `extractViewpointState` → `perspectiveToCamera`
 * → `Camera.setPosition`/`setTarget`, which store a pose verbatim by design,
 * and from there a single bad coordinate spreads across the whole pose.
 *
 * Two halves, and they are different failures (#2466):
 *
 *  1. **Prevention, at the parser.** A malformed viewpoint must not reach the
 *     camera at all. The parsers already treat `undefined` as "drop the thing
 *     I was reading" for a *missing* element, so reporting an unusable number
 *     the same way costs no new branch at any of the five call sites — which
 *     is why the boundary is the right place for it, rather than the six
 *     app-layer `getDistance()` consumers downstream. Guarding those
 *     individually is precisely the arrangement that let the gap open.
 *
 *  2. **Recovery, at the sink.** The viewer passes its live
 *     `camera.getDistance()` in as the reference distance, and that is raw by
 *     contract — `@ifc-lite/renderer` reports a malformed pose instead of
 *     hiding it. So once the camera was broken by *any* route, every restore
 *     computed `target = viewPoint + direction * NaN`, and restoring a
 *     known-good viewpoint — the obvious way out — could not repair it. One
 *     guard at the conversion sink covers every restore path.
 *
 * The prevention tests start from a real `.bcfzip` with an edited coordinate,
 * not a hand-built object, because the defect is a property of the file
 * boundary.
 */

import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readBCF } from './reader.js';
import { extractViewpointState, perspectiveToCamera, orthogonalToCamera } from './viewpoint.js';
import { computeMarkerPositions } from './overlay.js';
import type { BCFTopic } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DATA_DIR = join(__dirname, '..', 'test-data');

/**
 * Take a real buildingSMART fixture and corrupt exactly one number in its
 * viewpoint XML, then re-zip it. Everything else about the archive — the
 * version file, the markup, the snapshot — stays byte-identical, so a
 * behaviour change can only be attributed to the number.
 */
async function malformedArchive(
  fixture: 'PerspectiveCamera.bcf' | 'OrthogonalCamera.bcf',
  edit: (xml: string) => string,
): Promise<Uint8Array> {
  const original = await readFile(join(TEST_DATA_DIR, fixture));
  const zip = await JSZip.loadAsync(original);
  const viewpointName = Object.keys(zip.files).find((n) => n.endsWith('.bcfv'));
  if (!viewpointName) throw new Error(`no .bcfv in ${fixture}`);
  const xml = await zip.file(viewpointName)!.async('string');
  const edited = edit(xml);
  expect(edited, 'the edit must actually change the XML').not.toBe(xml);
  zip.file(viewpointName, edited);
  return zip.generateAsync({ type: 'uint8array' });
}

/** Replace the first `<X>` of the named element with `raw`. */
function poisonX(element: string, raw: string) {
  return (xml: string) =>
    xml.replace(
      new RegExp(`(<${element}>\\s*<X>)[^<]*(</X>)`),
      `$1${raw}$2`,
    );
}

async function firstViewpoint(bytes: Uint8Array) {
  const project = await readBCF(bytes);
  const topic = Array.from(project.topics.values())[0];
  expect(topic, 'the archive must still parse to a topic').toBeDefined();
  return { topic, viewpoint: topic.viewpoints[0] };
}

describe('BCF parser rejects a coordinate that is not a real number (#2466)', () => {
  // `"1e999"` is the reachability proof the whole family rests on: it is a
  // valid decimal literal that a well-meaning exporter could emit for a
  // runaway coordinate, and `parseFloat` turns it into `Infinity`. `"NaN"` and
  // `"-1e999"` are here because the three do not behave alike downstream —
  // a guard written `!Number.isNaN(...)` would satisfy only the first.
  for (const raw of ['1e999', '-1e999', 'NaN']) {
    it(`drops a perspective camera whose CameraViewPoint X is "${raw}"`, async () => {
      const bytes = await malformedArchive('PerspectiveCamera.bcf', poisonX('CameraViewPoint', raw));
      const { viewpoint } = await firstViewpoint(bytes);

      // The rest of the viewpoint survives — a viewpoint is more than its
      // camera, and dropping the whole thing would lose selection, visibility
      // and the snapshot along with it.
      expect(viewpoint).toBeDefined();
      expect(viewpoint.perspectiveCamera).toBeUndefined();

      // And the camera never reaches the viewer.
      expect(extractViewpointState(viewpoint, undefined, 25).camera).toBeUndefined();
    });

    it(`drops a perspective camera whose CameraDirection X is "${raw}"`, async () => {
      const bytes = await malformedArchive('PerspectiveCamera.bcf', poisonX('CameraDirection', raw));
      const { viewpoint } = await firstViewpoint(bytes);
      expect(viewpoint.perspectiveCamera).toBeUndefined();
    });

    it(`drops a perspective camera whose CameraUpVector X is "${raw}"`, async () => {
      // The `up` route specifically: it bypasses `setUp` on the animated
      // restore path and poisons the cursor-anchored zoom and the picking ray.
      const bytes = await malformedArchive('PerspectiveCamera.bcf', poisonX('CameraUpVector', raw));
      const { viewpoint } = await firstViewpoint(bytes);
      expect(viewpoint.perspectiveCamera).toBeUndefined();
    });

    it(`drops an orthogonal camera whose CameraViewPoint X is "${raw}"`, async () => {
      const bytes = await malformedArchive('OrthogonalCamera.bcf', poisonX('CameraViewPoint', raw));
      const { viewpoint } = await firstViewpoint(bytes);
      expect(viewpoint.orthogonalCamera).toBeUndefined();
    });
  }

  it('drops a perspective camera whose FieldOfView is not a real number', async () => {
    const bytes = await malformedArchive('PerspectiveCamera.bcf', (xml) =>
      xml.replace(/<FieldOfView>[^<]*<\/FieldOfView>/, '<FieldOfView>1e999</FieldOfView>'));
    const { viewpoint } = await firstViewpoint(bytes);
    expect(viewpoint.perspectiveCamera).toBeUndefined();
  });

  it('drops an orthogonal camera whose ViewToWorldScale is not a real number', async () => {
    // This one becomes the orthographic half-height, which `getOrthoSize()`
    // hands back into a saved viewpoint — so it persists past the session.
    const bytes = await malformedArchive('OrthogonalCamera.bcf', (xml) =>
      xml.replace(/<ViewToWorldScale>[^<]*<\/ViewToWorldScale>/, '<ViewToWorldScale>NaN</ViewToWorldScale>'));
    const { viewpoint } = await firstViewpoint(bytes);
    expect(viewpoint.orthogonalCamera).toBeUndefined();
  });

  it('anti-mutation: the untouched fixtures still parse their cameras', async () => {
    // Without this, every assertion above would pass against a parser that
    // had simply stopped reading cameras at all.
    const persp = await readBCF(await readFile(join(TEST_DATA_DIR, 'PerspectiveCamera.bcf')));
    const perspVp = Array.from(persp.topics.values())[0].viewpoints[0];
    expect(perspVp.perspectiveCamera).toBeDefined();
    expect(perspVp.perspectiveCamera!.fieldOfView).toBe(60);
    expect(Number.isFinite(perspVp.perspectiveCamera!.cameraViewPoint.x)).toBe(true);

    const ortho = await readBCF(await readFile(join(TEST_DATA_DIR, 'OrthogonalCamera.bcf')));
    const orthoVp = Array.from(ortho.topics.values())[0].viewpoints[0];
    expect(orthoVp.orthogonalCamera).toBeDefined();
    expect(Number.isFinite(orthoVp.orthogonalCamera!.viewToWorldScale)).toBe(true);
  });

  it('anti-mutation: legitimately extreme but finite coordinates still parse', async () => {
    // The guard is finiteness, not magnitude. A survey-grid coordinate of
    // 1e8 mm and a sub-millimetre 1e-9 are both real values a real exporter
    // writes; rejecting them would break well-formed files.
    for (const raw of ['1e8', '-1e8', '1e-9', '0']) {
      const bytes = await malformedArchive('PerspectiveCamera.bcf', poisonX('CameraViewPoint', raw));
      const { viewpoint } = await firstViewpoint(bytes);
      expect(viewpoint.perspectiveCamera, `"${raw}" must still parse`).toBeDefined();
      expect(viewpoint.perspectiveCamera!.cameraViewPoint.x).toBe(Number(raw));
    }
  });
});

describe('a broken pose cannot corrupt a viewpoint restore (#2466)', () => {
  const camera = {
    cameraViewPoint: { x: 1, y: 2, z: 3 },
    cameraDirection: { x: 0, y: 0, z: 1 },
    cameraUpVector: { x: 0, y: 1, z: 0 },
    fieldOfView: 60,
  };

  // These are exactly the values `Camera.getDistance()` reports once the pose
  // has gone wrong, plus the degenerate zero a camera that was never
  // positioned reports.
  const unusable = [Number.NaN, Infinity, -Infinity, 0];

  it('perspectiveToCamera falls back rather than multiplying by a broken distance', () => {
    for (const distance of unusable) {
      const state = perspectiveToCamera(camera, distance);
      for (const axis of ['x', 'y', 'z'] as const) {
        expect(Number.isFinite(state.position[axis]), `position.${axis} for ${distance}`).toBe(true);
        expect(Number.isFinite(state.target[axis]), `target.${axis} for ${distance}`).toBe(true);
      }
      // The fallback is the documented default, so the restored pose is the
      // same one a caller that passed nothing would have got.
      expect(state.target).toEqual(perspectiveToCamera(camera).target);
    }
  });

  it('orthogonalToCamera does the same', () => {
    const ortho = { ...camera, viewToWorldScale: 5 };
    for (const distance of unusable) {
      const state = orthogonalToCamera(ortho, distance);
      for (const axis of ['x', 'y', 'z'] as const) {
        expect(Number.isFinite(state.target[axis]), `target.${axis} for ${distance}`).toBe(true);
      }
      expect(state.target).toEqual(orthogonalToCamera(ortho).target);
    }
  });

  it('extractViewpointState — the call the viewer actually makes — is covered', () => {
    for (const distance of unusable) {
      const state = extractViewpointState(
        { guid: 'vp', perspectiveCamera: camera },
        undefined,
        distance,
      );
      expect(state.camera).toBeDefined();
      for (const axis of ['x', 'y', 'z'] as const) {
        expect(Number.isFinite(state.camera!.target[axis]), `target.${axis} for ${distance}`).toBe(true);
      }
    }
  });

  it('computeMarkerPositions is the third sink and behaves the same', () => {
    // Marker positions drive `Camera.framePoint`, which animates them into
    // position and target — so this one writes the pose too. A destructuring
    // default only fires for `undefined`; it does nothing for the `NaN` a
    // broken pose actually supplies.
    const topic: BCFTopic = {
      guid: 't1',
      title: 'topic',
      viewpoints: [{ guid: 'vp', perspectiveCamera: camera }],
      comments: [],
    } as unknown as BCFTopic;

    for (const targetDistance of unusable) {
      const markers = computeMarkerPositions([topic], () => null, { targetDistance });
      expect(markers.length, `markers for ${targetDistance}`).toBe(1);
      for (const axis of ['x', 'y', 'z'] as const) {
        expect(
          Number.isFinite(markers[0].position[axis]),
          `marker.position.${axis} for ${targetDistance}`,
        ).toBe(true);
      }
    }
  });

  it('anti-mutation: a usable distance is still used verbatim', () => {
    // If the fallback were over-broad, every restore would silently land at
    // the default distance and the assertions above would all still pass.
    const near = perspectiveToCamera(camera, 2);
    const far = perspectiveToCamera(camera, 200);
    expect(near.target).not.toEqual(far.target);
    expect(far.target.y).toBeCloseTo(camera.cameraViewPoint.z + 200, 6);

    const markers = computeMarkerPositions(
      [{ guid: 't1', title: 't', viewpoints: [{ guid: 'vp', perspectiveCamera: camera }], comments: [] } as unknown as BCFTopic],
      () => null,
      { targetDistance: 200 },
    );
    const defaulted = computeMarkerPositions(
      [{ guid: 't1', title: 't', viewpoints: [{ guid: 'vp', perspectiveCamera: camera }], comments: [] } as unknown as BCFTopic],
      () => null,
    );
    expect(markers[0].position).not.toEqual(defaulted[0].position);
  });
});

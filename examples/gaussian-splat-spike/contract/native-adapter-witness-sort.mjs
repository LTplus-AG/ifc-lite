/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #8564 scene (j) "sort refresh": upstream re-sorts on camera change only, and
// every refreshed order equals a from-scratch sort (remove + re-add at the same
// pose). A smooth orbit is not evidence of a correct order; this is.
// The spy wraps upstream's runtime-accessible SplatRenderer.prototype
// .getVisibleSplatReferences in the SAME module instance the adapter lazy-loads.
import { SplatRenderer } from '@luma.gl/splats';
import { BASE_OPTIONS, BLUE, RED, compare, composite, nonBackground, pixelAt, plain } from './native-adapter-witness-lib.mjs';

const PENDING = Object.freeze({ status: 'pending', reason: 'renderer.gaussianSplats is not available in this build' });
// Concentric on the optical axis at azimuth 0/180, separated along Z: red is in front
// from +Z, blue from -Z; view depth order flips at azimuth 90 degrees.
const NEAR = { x: 0, y: 0, z: 0.15, sigma: 0.25, opacity: 0.6, color: RED };
const FAR = { x: 0, y: 0, z: -0.15, sigma: 0.25, opacity: 0.6, color: BLUE };
const PATH = [0, 30, 60, 80, 100, 120, 150, 180];
const DISTANCE = 10;
const round12 = v => Math.round(v * 1e12) / 1e12;

function orbitPose(camera, degrees) {
  const a = degrees * Math.PI / 180;
  camera.setProjectionMode('perspective');
  camera.setUp(0, 1, 0);
  camera.setPosition(round12(DISTANCE * Math.sin(a)), 0, round12(DISTANCE * Math.cos(a)));
  camera.setTarget(0, 0, 0);
}
const savePose = camera => ({ projection: camera.getProjectionMode(), position: camera.getPosition(), target: camera.getTarget(), orthoSize: camera.getOrthoSize() });
function restorePose(camera, pose) {
  camera.setProjectionMode(pose.projection);
  camera.setPosition(pose.position.x, pose.position.y, pose.position.z);
  camera.setTarget(pose.target.x, pose.target.y, pose.target.z);
  if (pose.projection === 'orthographic') camera.setOrthoSize(pose.orthoSize);
}

/** Bounded walk from the layer to any SplatRenderer; a same-named non-instance means a duplicate module. */
function locateUpstream(root) {
  const seen = new Set();
  let frontier = [root], found = 0, lookalikes = 0;
  for (let depth = 0; depth < 7 && frontier.length; depth++) {
    const next = [];
    for (const object of frontier) {
      if (!object || typeof object !== 'object' || seen.has(object) || ArrayBuffer.isView(object)) continue;
      seen.add(object);
      if (object instanceof SplatRenderer) { found++; continue; }
      if (object.constructor?.name === 'SplatRenderer') lookalikes++;
      for (const value of Object.values(object)) if (value && typeof value === 'object') next.push(value);
    }
    frontier = next;
  }
  return { found, lookalikes };
}

function installSpy() {
  const original = SplatRenderer.prototype.getVisibleSplatReferences;
  if (typeof original !== 'function') throw new Error('upstream SplatRenderer.prototype.getVisibleSplatReferences is not accessible');
  const spy = { calls: 0, recomputed: 0, frozen: false, lastMatrix: null };
  SplatRenderer.prototype.getVisibleSplatReferences = function sortSpy() {
    spy.calls++;
    spy.lastMatrix = Array.from(this.props.modelViewProjectionMatrix);
    // Sensitivity control: hand back the previous (already sorted) references, so their
    // depths are never recomputed and the draw order stays the one from the old pose.
    if (spy.frozen && this.sortedReferences?.length) return this.sortedReferences;
    spy.recomputed++;
    return original.call(this);
  };
  spy.restore = () => { SplatRenderer.prototype.getVisibleSplatReferences = original; return SplatRenderer.prototype.getVisibleSplatReferences === original; };
  return spy;
}

/** j) Camera-driven re-sort, crossing-depth orbit and zoom, each against a fresh from-scratch reference. */
export async function sortRefresh(h) {
  const { renderer } = h;
  const camera = renderer.getCamera();
  const centre = [Math.floor(h.canvas.width / 2), Math.floor(h.canvas.height / 2)];
  orbitPose(camera, 0);
  const empty = await h.capture('empty');
  // Weights are exactly one at the axis pixel at azimuth 0 and 180: closed-form "over".
  const expected = { A: composite([0, 0, 0], [{ color: FAR.color, alpha: FAR.opacity }, { color: NEAR.color, alpha: NEAR.opacity }]),
    B: composite([0, 0, 0], [{ color: NEAR.color, alpha: NEAR.opacity }, { color: FAR.color, alpha: FAR.opacity }]) };
  const baseline = { emptyLitPixels: nonBackground(empty), centrePixel: centre, expected };
  if (!h.adapter) return { baseline, splat: PENDING };
  const { adapter } = h;
  const spy = installSpy();
  let handles = [];
  const addBoth = async () => { handles = [await h.add([NEAR]), await h.add([FAR])]; await h.settle({ handles, rows: 2 }); };
  const fresh = async name => { // a from-scratch upstream sort at the current pose
    for (const handle of handles) adapter.remove(handle);
    await h.settle({ rows: 0 });
    await addBoth();
    return h.capture(name);
  };
  const step = async (name, change, keep = false) => {
    const before = { calls: spy.calls, recomputed: spy.recomputed };
    change();
    const frame = await h.capture(name, BASE_OPTIONS, { keep });
    return { frame, record: { name, sorts: spy.calls - before.calls, recomputed: spy.recomputed - before.recomputed,
      lastEncodeMs: adapter.getStats().lastEncodeMs, centre: pixelAt(frame, ...centre), pose: plain(savePose(camera)) } };
  };
  try {
    await addBoth();
    const upstream = locateUpstream(adapter);
    // 1) Sort calls follow camera changes, not frames.
    orbitPose(camera, 0);
    await h.capture('settled-at-a');
    const counts = {};
    counts.still = (await step('still', () => {})).record;
    counts.orbitApi = (await step('orbit-api', () => camera.orbit(40, 0))).record;
    counts.stillAfterOrbit = (await step('still-after-orbit', () => {})).record;
    orbitPose(camera, 30);
    await h.capture('zoom-start');
    counts.zoomPerspective = (await step('zoom-perspective', () => camera.zoom(-300))).record;
    camera.setProjectionMode('orthographic');
    await h.capture('ortho-start');
    counts.zoomOrthographic = (await step('zoom-orthographic', () => camera.zoom(-300))).record;
    // 2) Crossing-depth orbit A (0) -> B (180): the incremental path first, fresh references after.
    const path = [];
    for (const degrees of PATH) {
      const { frame, record } = await step(`orbit-${degrees}`, () => orbitPose(camera, degrees), degrees === 0 || degrees === 180);
      path.push({ degrees, frame, record: { degrees, ...record } });
    }
    for (const entry of path) {
      orbitPose(camera, entry.degrees);
      const reference = await fresh(`orbit-${entry.degrees}-fresh`);
      entry.record.equalsFresh = compare(entry.frame, reference);
    }
    // 3) Zoom: dolly and orthographic zoom keep depth order; each zoomed frame equals a fresh sort.
    const zoom = [];
    for (const projection of ['perspective', 'orthographic']) {
      orbitPose(camera, 150);
      if (projection === 'orthographic') camera.setProjectionMode('orthographic');
      await fresh(`zoom-${projection}-start`);
      for (const [index, delta] of [-300, -300, 500].entries()) {
        const { frame, record } = await step(`zoom-${projection}-${index}`, () => camera.zoom(delta));
        zoom.push({ projection, delta, frame, record });
      }
    }
    for (const entry of zoom) {
      restorePose(camera, entry.record.pose);
      entry.record.equalsFresh = compare(entry.frame, await fresh(`${entry.record.name}-fresh`));
    }
    // 4) Sensitivity control: freeze the sort. The orbit must expose the stale order; zoom must not.
    const frozen = {};
    orbitPose(camera, 0);
    await fresh('frozen-orbit-start');
    spy.frozen = true;
    const orbitFrozen = await step('frozen-orbit-180', () => orbitPose(camera, 180), true);
    spy.frozen = false;
    frozen.orbit = { ...orbitFrozen.record, equalsFresh: compare(orbitFrozen.frame, path.at(-1).frame) };
    const zoomStart = zoom.find(entry => entry.projection === 'perspective');
    restorePose(camera, path.find(entry => entry.degrees === 150).record.pose);
    await fresh('frozen-zoom-start');
    spy.frozen = true;
    const zoomFrozen = await step('frozen-zoom', () => restorePose(camera, zoomStart.record.pose));
    spy.frozen = false;
    frozen.zoom = { ...zoomFrozen.record, equalsFresh: compare(zoomFrozen.frame, zoomStart.frame) };
    return {
      baseline,
      splat: { upstream, counts, path: path.map(entry => entry.record), zoom: zoom.map(entry => entry.record), frozen, spyRestored: spy.restore() },
    };
  } finally {
    spy.frozen = false;
    spy.restore();
  }
}

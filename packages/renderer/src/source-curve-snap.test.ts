/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sourceCurveSnapCandidate, sourceCurveMayReachRay, sourceWinsOverMeshSnap, type SourceSnapCurve } from './source-curve-snap.js';
import { SnapType } from './snap-detector.js';
import { pointCloudWinsOverSourceSnap } from './raycast-point-cloud-query.js';

const identity = { modelId: 'model-a', expressId: 132347, solidId: 132399, directrixId: 132399,
  mappingPath: [132401], occurrenceIndex: 0, segmentIndex: 2 };
const project = (point: { x: number; y: number }) => ({ x: point.x, y: point.y });
const accepts = () => true;

describe('authored source snapping (#5780)', () => {
  it('snaps to the f64 arc rather than its display chord, including a reversed sweep', () => {
    const arc = (start: number, sweep: number): SourceSnapCurve => ({
      identity, globalId: 1_132_347, kind: 'arc', length: Math.abs(sweep), sweepAngle: sweep,
      pointAt: (t) => ({ x: Math.cos(start + sweep * t), y: Math.sin(start + sweep * t), z: 0 }),
    });
    const q = Math.SQRT1_2;
    for (const curve of [arc(0, Math.PI / 2), arc(Math.PI / 2, -Math.PI / 2)]) {
      const hit = sourceCurveSnapCandidate([curve], q, q, 0.02, project, accepts);
      assert.ok(hit);
      assert.ok(Math.abs(hit.target.position.x - q) < 1e-7);
      assert.ok(Math.abs(hit.target.position.y - q) < 1e-7);
      assert.equal(hit.target.type, SnapType.EDGE);
      assert.equal(hit.target.metadata?.sourceCurve?.modelId, 'model-a');
      assert.equal(hit.target.metadata?.sourceCurve?.segmentIndex, 2);
      assert.deepEqual(hit.target.metadata?.sourceCurve?.mappingPath, [132401]);
      assert.equal(hit.target.expressId, 1_132_347);
      assert.ok(Math.abs(hit.target.position.x - 0.5) > 0.2, 'a chord midpoint is never the snap point');
    }
  });

  it('keeps endpoints, pixel radius, clipping and large-coordinate residuals exact', () => {
    const base = 5_000_000;
    const line: SourceSnapCurve = {
      identity, globalId: 1_132_347, kind: 'line', length: 0.01,
      pointAt: (t) => ({ x: base + t * 0.01, y: 0, z: 0 }),
    };
    const screen = (point: { x: number; y: number }) => ({ x: (point.x - base) * 1_000, y: point.y });
    const start = sourceCurveSnapCandidate([line], 0, 0, 2, screen, accepts);
    assert.equal(start?.target.type, SnapType.VERTEX);
    const interior = sourceCurveSnapCandidate([line], 3.25, 0, 2, screen, accepts);
    assert.ok(interior);
    assert.ok(Math.abs(interior.target.position.x - (base + 0.00325)) < 1e-6);
    assert.equal(interior.target.type, SnapType.EDGE);
    assert.equal(sourceCurveSnapCandidate([line], 3.25, 0, 0, screen, accepts), null);
    assert.equal(sourceCurveSnapCandidate([line], 3.25, 0, 2, screen, () => false), null);
    assert.equal(sourceCurveSnapCandidate([line], 30, 0, 2, screen, accepts), null);
  });

  it('gives mesh vertices, edges and faces priority at a tie, and foreground scan points priority by depth', () => {
    const curve: SourceSnapCurve = { identity, globalId: 1_132_347, kind: 'line', length: 2,
      pointAt: (t) => ({ x: t * 2 - 1, y: 0, z: 0 }) };
    const source = sourceCurveSnapCandidate([curve], 0, 0, 4, project, accepts);
    assert.ok(source);
    for (const type of [SnapType.VERTEX, SnapType.EDGE]) {
      const mesh = { type, position: { x: 0, y: 0, z: 1 }, expressId: 4, confidence: 0.1 };
      assert.equal(sourceWinsOverMeshSnap(source, mesh, 0, 0, project), false);
      assert.equal(sourceWinsOverMeshSnap(source, { ...mesh, position: { x: 2, y: 0, z: 1 } }, 0, 0, project), true);
    }
    for (const type of [SnapType.FACE_CENTER, SnapType.FACE]) {
      assert.equal(sourceWinsOverMeshSnap(source,
        { type, position: { x: 0, y: 0, z: 1 }, expressId: 4, confidence: 1 }, 0, 0, project), true);
    }
    const ray = { origin: { x: 0, y: 0, z: 10 }, direction: { x: 0, y: 0, z: -1 } };
    const camera = { fov: Math.PI / 3, canvasHeightPx: 800, orthoHalfHeight: 1 };
    const coincident = { position: { x: 0, y: 0, z: 0.001 }, expressId: 5, distance: 9.999 };
    const foreground = { ...coincident, position: { x: 0, y: 0, z: 2 }, distance: 8 };
    assert.equal(pointCloudWinsOverSourceSnap(coincident, source.target, ray, camera), false);
    assert.equal(pointCloudWinsOverSourceSnap(foreground, source.target, ray, camera), true);
  });

  it('finds a clipped line interior and a sub-sample-width visible arc (#5780)', () => {
    const line: SourceSnapCurve = { identity, globalId: 42, kind: 'line', length: 1,
      pointAt: (t) => ({ x: t, y: 0, z: 0 }) };
    const lineClip = { clipBox: { enabled: true, min: [0.49999, -1, -1] as [number, number, number],
      max: [0.50001, 1, 1] as [number, number, number] } };
    const lineHit = sourceCurveSnapCandidate([line], 0.5, 0, 0.001, project, accepts, lineClip);
    assert.ok(lineHit, 'both endpoints are clipped, but the interior is visible');
    assert.ok(Math.abs(lineHit.target.position.x - 0.5) < 1e-7);

    const arc: SourceSnapCurve = { identity, globalId: 42, kind: 'arc', length: Math.PI,
      sweepAngle: Math.PI,
      pointAt: (t) => ({ x: Math.cos(Math.PI * t), y: Math.sin(Math.PI * t), z: 0 }) };
    const angle = Math.PI / 2 + 0.001;
    const px = Math.cos(angle), py = Math.sin(angle);
    const arcClip = { clipBox: { enabled: true,
      min: [px - 0.000001, py - 0.000001, -1] as [number, number, number],
      max: [px + 0.000001, py + 0.000001, 1] as [number, number, number] } };
    const arcHit = sourceCurveSnapCandidate([arc], px, py, 0.0001, project, accepts, arcClip);
    assert.ok(arcHit, 'the visible interval is narrower than a sampling step and between samples');
    assert.ok(Math.hypot(arcHit.target.position.x - px, arcHit.target.position.y - py) < 1e-7);
    const reversed: SourceSnapCurve = { ...arc, sweepAngle: -Math.PI,
      pointAt: (t) => ({ x: Math.cos(Math.PI - Math.PI * t), y: Math.sin(Math.PI - Math.PI * t), z: 0 }) };
    const reverseHit = sourceCurveSnapCandidate([reversed], px, py, 0.0001, project, accepts, arcClip);
    assert.ok(reverseHit, 'the same narrow clip remains reachable on a reversed source arc');
    assert.ok(Math.hypot(reverseHit.target.position.x - px, reverseHit.target.position.y - py) < 1e-7);
  });

  it('obeys independent vertex/edge toggles and culls offscreen bounds before evaluation', () => {
    let evaluations = 0;
    const line: SourceSnapCurve = { identity, globalId: 42, kind: 'line', length: 1,
      bounds: { center: { x: 0.5, y: 0, z: 0 }, radius: 0.5 },
      pointAt: (t) => { evaluations++; return { x: t, y: 0, z: 0 }; } };
    const endpointsOnly = { snapToVertices: true, snapToEdges: false };
    assert.equal(sourceCurveSnapCandidate([line], 0.5, 0, 0.1, project, accepts, undefined, endpointsOnly), null);
    assert.equal(sourceCurveSnapCandidate([line], 0, 0, 0.1, project, accepts, undefined, endpointsOnly)?.target.type, SnapType.VERTEX);
    const edgesOnly = { snapToVertices: false, snapToEdges: true };
    assert.equal(sourceCurveSnapCandidate([line], 0, 0, 0.1, project, accepts, undefined, edgesOnly)?.target.type, SnapType.EDGE);
    const pixels = (point: { x: number; y: number }) => ({ x: point.x * 100, y: point.y * 100 });
    const nearStart = sourceCurveSnapCandidate([line], -1, 0, 20, pixels, accepts, undefined, edgesOnly);
    assert.equal(nearStart?.target.type, SnapType.EDGE, 'the line remains snappable near its endpoint with vertex snaps off');
    assert.equal(nearStart?.target.metadata?.sourceCurve?.t, 0);
    assert.equal(sourceCurveSnapCandidate([line], 0.5, 0, 0.1, project, accepts, undefined, edgesOnly)?.target.type, SnapType.EDGE);
    assert.equal(sourceCurveSnapCandidate([line], 0.5, 0, 0.1, project, accepts, undefined,
      { snapToVertices: false, snapToEdges: false }), null);
    const ray = { origin: { x: 100, y: 0, z: 10 }, direction: { x: 0, y: 0, z: -1 } };
    assert.equal(sourceCurveMayReachRay(line, ray, 10, Math.PI / 3, 800, 1), false);
    assert.equal(sourceCurveMayReachRay(line, { ...ray, origin: { x: 0.5, y: 0, z: 10 } },
      10, Math.PI / 3, 800, 1), true);
    assert.equal(sourceCurveMayReachRay({ ...line, bounds: { center: { x: 5_000_000.5, y: 0, z: 0 }, radius: 0.5 } },
      { ...ray, origin: { x: 5_000_000.5, y: 0, z: 10 } }, 10, Math.PI / 3, 800, 1), true);
    evaluations = 0;
    assert.equal(sourceCurveSnapCandidate([line], 0.5, 0, 0.1, project, accepts, undefined, undefined,
      (curve) => sourceCurveMayReachRay(curve, ray, 10, Math.PI / 3, 800, 1)), null);
    assert.equal(evaluations, 0, 'offscreen curves incur no source evaluations or projections');
  });

  it('rejects clipped points after a non-affine cross-CRS display map', () => {
    const curve: SourceSnapCurve = { identity, globalId: 42, kind: 'line', length: 1,
      affineDisplayFrame: false,
      pointAt: (t) => ({ x: t + 0.05 * Math.sin(2 * Math.PI * t), y: 0, z: 0 }) };
    const clip = { clipBox: { enabled: true, min: [0.4, -1, -1] as [number, number, number],
      max: [0.6, 1, 1] as [number, number, number] } };
    assert.equal(sourceCurveSnapCandidate([curve], 0.8, 0, 0.01, project, accepts, clip), null);
    assert.ok(sourceCurveSnapCandidate([curve], 0.5, 0, 0.01, project, accepts, clip));
  });

  it('finds the closest valley of an unclipped non-affine cross-CRS line (#6280)', () => {
    const curve: SourceSnapCurve = { identity, globalId: 42, kind: 'line', length: 1,
      affineDisplayFrame: false,
      pointAt: (t) => ({ x: t, y: 0.3 * Math.sin(4 * Math.PI * t), z: 0 }) };
    const hit = sourceCurveSnapCandidate([curve], 0.5, 0, 0.01, project, accepts);
    assert.ok(hit, 'another screen-space valley must not hide the point under the cursor');
    assert.ok(Math.abs((hit.target.metadata?.sourceCurve?.t ?? Infinity) - 0.5) < 1e-7);
    assert.equal(hit.target.type, SnapType.EDGE);
  });

  it('finds a thin visible island and its boundary on a clipped non-affine line (#6280)', () => {
    const curve: SourceSnapCurve = { identity, globalId: 42, kind: 'line', length: 100,
      affineDisplayFrame: false,
      pointAt: (t) => ({ x: 100 * t, y: 0.01 * Math.sin(2 * Math.PI * t), z: 0 }) };
    const clip = { clipBox: { enabled: true, min: [1, -1, -1] as [number, number, number],
      max: [1.0001, 1, 1] as [number, number, number] } };
    const centre = sourceCurveSnapCandidate([curve], 1.00005, 0.01 * Math.sin(0.020001 * Math.PI),
      0.0001, project, accepts, clip);
    assert.ok(centre, 'both clip boundaries fall between the original coarse samples');
    assert.ok(Math.abs(centre.target.position.x - 1.00005) < 1e-6);
    const nearBoundary = sourceCurveSnapCandidate([curve], 0.99995, 0.01 * Math.sin(0.02 * Math.PI),
      0.0002, project, accepts, clip);
    assert.ok(nearBoundary, 'the nearest visible point can lie on a clip boundary');
    assert.ok(nearBoundary.target.position.x >= 1 && nearBoundary.target.position.x <= 1.0001);
    assert.ok(Math.abs(nearBoundary.target.position.x - 1) < 1e-6);
  });

  it('does not return a point behind a perspective near plane', () => {
    const line: SourceSnapCurve = { identity, globalId: 42, kind: 'line', length: 2,
      pointAt: (t) => ({ x: t, y: 0, z: 1 - 2 * t }) };
    const perspective = (point: { x: number; y: number; z: number }) =>
      point.z < -0.1 ? { x: point.x / -point.z, y: point.y / -point.z } : null;
    const hit = sourceCurveSnapCandidate([line], 1, 0, 2, perspective, accepts);
    assert.ok(hit);
    assert.ok(hit.target.position.z < -0.1);
    const behind = sourceCurveSnapCandidate([line], 0, 0, 0.01, perspective, accepts);
    assert.equal(behind, null);
  });

  it('finds a visible line interior when the near plane hides both first search probes (#6280)', () => {
    const line: SourceSnapCurve = { identity, globalId: 42, kind: 'line', length: 1,
      pointAt: (t) => ({ x: t, y: 0, z: t - 0.8 }) };
    const projectPastNearPlane = (point: { x: number; y: number; z: number }) =>
      point.z > 0 ? { x: point.x, y: point.y } : null;
    const hit = sourceCurveSnapCandidate([line], 0.9, 0, 0.01, projectPastNearPlane, accepts);
    assert.ok(hit, 'a visible interior point must remain reachable beyond an unprojectable prefix');
    assert.ok(Math.abs(hit.target.position.x - 0.9) < 1e-6);
    assert.equal(hit.target.type, SnapType.EDGE);
  });
});

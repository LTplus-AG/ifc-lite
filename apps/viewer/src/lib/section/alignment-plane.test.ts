/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create } from 'zustand';
import { alignmentSectionPlane } from './alignment-plane';
import { createSectionSlice, customPlaneCenter, type SectionSlice } from '@/store/slices/sectionSlice';

const binding = { modelId: 'model-A', expressId: 20, geometricHorizontalDistanceMeters: 5, geometricHorizontalLengthMeters: 10 };
const dot = (a: readonly number[], b: readonly number[]) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('alignment section rebases f64 before placement, preserves grade and exact station plane (#6603)', () => {
  const grade = 1 / Math.sqrt(1.01);
  const plane = alignmentSectionPlane({ geometricHorizontalDistanceMeters: 5,
    point: [3_513_037.015625, 5_516_199.03125, 100.5], tangent: [grade, 0, grade * 0.1] },
  { wasmRtcOffset: { x: 3_513_037, y: 5_516_199, z: 100 }, originShift: { x: 0, y: 0, z: 0 } },
  [2, 3, 4], binding);
  assert.deepEqual(plane.pickedAt, [2.015625, 4.5, -3.03125]);
  near(dot(plane.pickedAt, plane.normal), plane.distance);
  near(Math.hypot(...plane.normal), 1);
  near(plane.normal[0], grade); near(plane.normal[1], grade * 0.1); near(plane.normal[2], 0);
  near(dot(plane.tangent, plane.normal), 0); near(dot(plane.bitangent, plane.normal), 0);
  assert.deepEqual(customPlaneCenter(plane), plane.pickedAt);
});

test('alignment section normal changes with an analytic circular station instead of sliding parallel (#6603)', () => {
  const at = (angle: number) => alignmentSectionPlane({ geometricHorizontalDistanceMeters: angle * 10,
    point: [10 * Math.sin(angle), 10 * (1 - Math.cos(angle)), 0],
    tangent: [Math.cos(angle), Math.sin(angle), 0] }, undefined, [0, 0, 0], binding);
  const initial = at(0), turn = at(Math.PI / 2);
  near(dot(initial.normal, turn.normal), 0);
  near(turn.pickedAt[0], 10); near(turn.pickedAt[1], 0); near(turn.pickedAt[2], -10);
  near(dot(turn.pickedAt, turn.normal), turn.distance);
});

test('manual section drag detaches the binding while preserving the requested plane and flip (#6603)', () => {
  const custom = alignmentSectionPlane({ geometricHorizontalDistanceMeters: 5, point: [5, 0, 0.5],
    tangent: [1 / Math.sqrt(1.01), 0, 0.1 / Math.sqrt(1.01)] }, undefined, [0, 0, 0], binding);
  const store = create<SectionSlice>()((...args) => createSectionSlice(...args));
  store.setState({ sectionPlane: { ...store.getState().sectionPlane, custom, flipped: true, enabled: true } });
  store.getState().setSectionCustomDistance(custom.distance + 2);
  const result = store.getState().sectionPlane;
  assert.equal(result.custom?.alignment, undefined);
  assert.equal(result.flipped, true);
  assert.deepEqual(result.custom?.normal, custom.normal);
  assert.ok(result.custom);
  near(dot(customPlaneCenter(result.custom), result.custom.normal), custom.distance + 2);
  store.getState().setSectionPlaneAxis('down');
  assert.equal(store.getState().sectionPlane.custom, undefined);
});

test('alignment frame rejects nonfinite station coordinates rather than poisoning clipping (#6603)', () => {
  assert.throws(() => alignmentSectionPlane({ geometricHorizontalDistanceMeters: 0,
    point: [Infinity, 0, 0], tangent: [1, 0, 0] }, undefined, [0, 0, 0], binding));
});

test('placed alignment rotates its station and normal about the engineering pivot before translating (#6603)', () => {
  const plane = alignmentSectionPlane({ geometricHorizontalDistanceMeters: 5, point: [5, 2, 1],
    tangent: [1, 0, 0] }, undefined, [10, 20, 30], binding, { angle: Math.PI / 2, pivot: [2, 2, 0] });
  near(plane.pickedAt[0], 12); near(plane.pickedAt[1], 31); near(plane.pickedAt[2], -25);
  near(plane.normal[0], 0); near(plane.normal[1], 0); near(plane.normal[2], -1);
  near(dot(plane.pickedAt, plane.normal), plane.distance);
});

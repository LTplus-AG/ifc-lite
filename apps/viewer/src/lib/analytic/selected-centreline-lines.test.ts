/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { useViewerStore } from '@/store/index.js';
import type { SelectedSweptDisk } from '@/hooks/useSelectedSweptDisks.js';
import { selectedCentrelineWorldLines } from './selected-centreline-lines.js';

function selected(modelId: string, startX: number, sourceModified = false): SelectedSweptDisk {
  return {
    ref: { modelId, expressId: 42 }, diagnostics: [], occurrences: [{
      solid_id: 91, directrix_id: 92, mapping_path: [], source_modified: sourceModified,
      Radius: 0.01, InnerRadius: null, status: { type: 'complete' },
      directrix_metrics: { total_length: 0.002, segments: [{ segment_index: 0, length: 0.002, bend_angle: null }] },
      Directrix: [{ type: 'line', start: [startX, 1, 2], end: [startX + 0.002, 1, 2] }],
    }],
  };
}

describe('selected centreline overlay (#5778)', () => {
  it('keeps an in-budget directrix larger than the JavaScript argument limit', async () => {
    const zero = { x: 0, y: 0, z: 0 };
    const box = { min: zero, max: zero };
    const prior = useViewerStore.getState();
    try {
      useViewerStore.setState({ models: new Map(), geometryResult: {
        meshes: [], totalVertices: 0, totalTriangles: 0,
        coordinateInfo: { originShift: zero, wasmRtcOffset: zero,
          hasLargeCoordinates: false, originalBounds: box, shiftedBounds: box },
      } });
      const item = selected('legacy', 0);
      const occurrence = item.occurrences[0];
      if (!occurrence) throw new Error('the line fixture has no source occurrence');
      const segments = Array.from({ length: 30_000 }, (_, index) => ({
        type: 'line' as const, start: [index, 0, 0] as [number, number, number],
        end: [index + 1, 0, 0] as [number, number, number],
      }));
      const result = await selectedCentrelineWorldLines([
        { ...item, occurrences: [{ ...occurrence, Directrix: segments }] },
      ], useViewerStore.getState());
      assert.equal(result.vertices.length, 180_000);
      assert.equal(result.vertices[0], 0);
      assert.equal(result.vertices.at(-3), 30_000);
      assert.deepEqual(result.diagnostics, []);
    } finally {
      useViewerStore.setState(prior);
    }
  });

  it('keeps a later valid sweep when an earlier complete arc exceeds the display budget', async () => {
    const zero = { x: 0, y: 0, z: 0 };
    const box = { min: zero, max: zero };
    const prior = useViewerStore.getState();
    try {
      useViewerStore.setState({ models: new Map(), geometryResult: {
        meshes: [], totalVertices: 0, totalTriangles: 0,
        coordinateInfo: { originShift: zero, wasmRtcOffset: { x: 100, y: 0, z: 0 },
          hasLargeCoordinates: false, originalBounds: box, shiftedBounds: box },
      } });
      const item = selected('legacy', 101);
      const valid = item.occurrences[0];
      if (!valid) throw new Error('the line fixture has no source occurrence');
      const oversized = { ...valid, solid_id: 90, Directrix: [{
        type: 'arc' as const, center: [101, 1, 2] as [number, number, number],
        normal: [0, 0, 1] as [number, number, number],
        x_axis: [1, 0, 0] as [number, number, number],
        radius: 10_000, start_angle: 0, sweep_angle: Math.PI * 2,
      }] };
      const result = await selectedCentrelineWorldLines([
        { ...item, occurrences: [oversized, valid] },
      ], useViewerStore.getState());
      assert.ok(Math.abs(result.vertices[0] - 1) < 1e-9);
      assert.ok(Math.abs(result.vertices[3] - 1.002) < 1e-9);
      assert.equal(result.vertices.length, 6, 'the later source sweep still renders');
      assert.match(result.diagnostics.join('; '), /solid #90.*display precision budget/);
    } finally {
      useViewerStore.setState(prior);
    }
  });

  it('uses the legacy single-model geometry frame when no federation map exists', async () => {
    const zero = { x: 0, y: 0, z: 0 };
    const box = { min: zero, max: zero };
    const prior = useViewerStore.getState();
    try {
      useViewerStore.setState({ models: new Map(), geometryResult: {
        meshes: [], totalVertices: 0, totalTriangles: 0,
        coordinateInfo: { originShift: zero, wasmRtcOffset: { x: 100, y: 0, z: 0 },
          hasLargeCoordinates: false, originalBounds: box, shiftedBounds: box },
      } });
      const result = await selectedCentrelineWorldLines([selected('legacy', 101)], useViewerStore.getState());
      assert.ok(Math.abs(result.vertices[0] - 1) < 1e-9);
      assert.ok(Math.abs(result.vertices[3] - 1.002) < 1e-9);
    } finally {
      useViewerStore.setState(prior);
    }
  });

  it('keeps colliding local ids in their own RTC model frames and explains omitted sources', async () => {
    const first = fixtureModel('first', { idOffset: 1_000_000 });
    const second = fixtureModel('second', { idOffset: 2_000_000 });
    const frame = (x: number) => {
      const zero = { x: 0, y: 0, z: 0 };
      const box = { min: zero, max: zero };
      return { originShift: zero, wasmRtcOffset: { x, y: 0, z: 0 }, hasLargeCoordinates: true,
        originalBounds: box, shiftedBounds: box };
    };
    first.geometryResult = { meshes: [], totalVertices: 0, totalTriangles: 0,
      coordinateInfo: frame(5_000_000) };
    second.geometryResult = { meshes: [], totalVertices: 0, totalTriangles: 0,
      coordinateInfo: frame(100) };
    const prior = useViewerStore.getState();
    try {
      useViewerStore.setState(fixtureModels(first, second));
      const result = await selectedCentrelineWorldLines([
        selected('first', 5_000_000.001), selected('second', 101),
        { ...selected('second', 101, true), diagnostics: ['product #42: modified by boolean operation'] },
        { ...selected('second', 101), occurrences: [{
          ...selected('second', 101).occurrences[0]!,
          status: { type: 'unsupported', reason: 'unsupported directrix' },
        }] },
      ], useViewerStore.getState());
      assert.ok(Math.abs(result.vertices[0] - 0.001) < 1e-9);
      assert.ok(Math.abs(result.vertices[3] - 0.003) < 1e-9);
      assert.deepEqual(result.vertices.slice(1, 3), [2, -1]);
      assert.ok(Math.abs(result.vertices[6] - 1) < 1e-9);
      assert.ok(Math.abs(result.vertices[9] - 1.002) < 1e-9);
      assert.deepEqual([result.vertices[7], result.vertices[8], result.vertices[10], result.vertices[11]], [2, -1, 2, -1]);
      assert.equal(result.diagnostics.length, 3);
      assert.match(result.diagnostics[0], /modified by boolean operation/);
      assert.match(result.diagnostics[1], /does not describe the visible solid/);
      assert.match(result.diagnostics[2], /unsupported source \(unsupported directrix\)/);
    } finally {
      useViewerStore.setState(prior);
    }
  });

  it('isolates a selected segment by model, occurrence and index (#5783)', async () => {
    const first = fixtureModel('first', { idOffset: 1_000_000 });
    const second = fixtureModel('second', { idOffset: 2_000_000 });
    const zero = { x: 0, y: 0, z: 0 };
    const box = { min: zero, max: zero };
    const geometry = { meshes: [], totalVertices: 0, totalTriangles: 0,
      coordinateInfo: { originShift: zero, wasmRtcOffset: zero, hasLargeCoordinates: false,
        originalBounds: box, shiftedBounds: box } };
    first.geometryResult = geometry;
    second.geometryResult = geometry;
    const prior = useViewerStore.getState();
    try {
      useViewerStore.setState(fixtureModels(first, second));
      const secondItem = selected('second', 10);
      const firstOccurrence = secondItem.occurrences[0]!;
      secondItem.occurrences.push({
        ...firstOccurrence,
        solid_id: 93,
        Directrix: [
          { type: 'line', start: [20, 0, 0], end: [21, 0, 0] },
          { type: 'line', start: [21, 0, 0], end: [22, 0, 0] },
        ],
      });
      const result = await selectedCentrelineWorldLines(
        [selected('first', 100), secondItem], useViewerStore.getState(),
        { modelId: 'second', expressId: 42, occurrenceIndex: 1, segmentIndex: 1 },
      );
      assert.equal(result.vertices.length, 6);
      assert.deepEqual(result.vertices, [21, 0, 0, 22, 0, 0]);
    } finally {
      useViewerStore.setState(prior);
    }
  });
});

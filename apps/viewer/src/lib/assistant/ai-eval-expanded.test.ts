/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EXPANDED_SCENES } from '@/test/ai-eval-expanded-scenes';
import { seedScene, comparableEvidence } from '@/test/ai-eval-scenes';

for (const scene of EXPANDED_SCENES) {
  test(`#6928 ${scene} captures available native evidence reproducibly`, async () => {
    const first = await seedScene(scene); const second = await seedScene(scene);
    assert.equal(first.kind, 'ready'); assert.equal(second.kind, 'ready');
    if (first.kind !== 'ready' || second.kind !== 'ready') return;
    const evidence = comparableEvidence(first.evidence);
    assert.equal(evidence.sourceAvailability, 'available'); assert.ok(first.evidence.includedRows > 0);
    assert.deepEqual(evidence, comparableEvidence(second.evidence));
    const native = evidence.evidence as { summary: Record<string, unknown>; rows: Array<{ data: Record<string, unknown> }> };
    if (scene === 'flow-ai-paused') {
      assert.equal(native.summary.verdict, 'review-required'); assert.equal(native.summary.writes, 0);
      assert.deepEqual(native.summary.nodeStatusCounts, { ok: 2, memo: 0, noop: 0, skipped: 0, error: 0, review: 1, paused: 1, restored: 0 });
      assert.equal(native.summary.executedNodes, 3);
    } else if (scene === 'lists-sample') {
      assert.equal(native.summary.totalCount, 4); // Four IFCWALL records in the independently authored SketchUp file.
      const values = native.rows.map(row => row.data.values as Record<string, unknown>);
      assert.ok(Math.abs(Number(values[0].Length) - 1800) < 1e-6); // Source #274 IFCQUANTITYLENGTH, in mm.
      assert.ok(values.every(row => row.Height === null), 'absent source Height is a gap, never zero or inferred');
    } else if (scene === 'selection-sample') {
      const row = native.rows[0].data;
      assert.equal(row.globalId, '12UVOn4wvAJPMUExKdZLb8'); assert.equal(row.type, 'IfcSlab');
      assert.equal(row.name, 'house - roof - slab right'); assert.equal(row.qsetCount, 1);
    } else if (scene === 'review-rev-b') {
      assert.equal(native.summary.humanDecision, null); assert.equal(native.summary.state, 'current');
      assert.equal(native.rows[0].data.status, 'failed');
      assert.equal(native.rows[0].data.title, 'Building element proxies declare an ObjectType'); // Committed native IDS.
    } else {
      assert.equal(native.summary.blockCount, 2);
      assert.equal(native.rows[0].data.textExcerpt, '{IfcProject.Name}');
      assert.deepEqual(native.rows[0].data.bindings, ['IfcProject.Name']);
    }
  });
}

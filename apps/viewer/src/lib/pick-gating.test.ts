/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isGeometryLoadStreaming } from './pick-gating.js';

// `isGeometryLoadStreaming` is the gate behind `getPickOptions().isStreaming`:
// when it returns true, `PickingManager.pick()` bails to null. These tests pin
// the exact regression from #1570 — a federated georeferenced model leaves
// `progress` stuck below 100% after the load has finished, which must NOT keep
// element picking disabled.

describe('isGeometryLoadStreaming', () => {
  it('reports streaming while geometry is actively streaming', () => {
    assert.equal(
      isGeometryLoadStreaming({
        geometryStreamingActive: true,
        loading: true,
        progress: { phase: 'Streaming', percent: 40 },
      }),
      true,
    );
  });

  it('reports streaming for an in-flight load below 100% even without the streaming flag', () => {
    assert.equal(
      isGeometryLoadStreaming({
        geometryStreamingActive: false,
        loading: true,
        progress: { phase: 'Processing geometry', percent: 50 },
      }),
      true,
    );
  });

  // Regression #1570: two georeferenced IFC files. Finalizing the second
  // (federated) model runs after the streaming "Complete" and re-sets progress
  // to "Aligning georeferenced model" 90%. Once the load has finished
  // (loading=false, geometryStreamingActive=false) that stale 90% must NOT keep
  // picking disabled — otherwise no element in EITHER model is selectable.
  it('does NOT report streaming when a finished load left progress stuck below 100% (#1570)', () => {
    assert.equal(
      isGeometryLoadStreaming({
        geometryStreamingActive: false,
        loading: false,
        progress: { phase: 'Aligning georeferenced model', percent: 90 },
      }),
      false,
    );
  });

  it('does NOT report streaming once fully complete', () => {
    assert.equal(
      isGeometryLoadStreaming({
        geometryStreamingActive: false,
        loading: false,
        progress: { phase: 'Complete', percent: 100 },
      }),
      false,
    );
    assert.equal(
      isGeometryLoadStreaming({
        geometryStreamingActive: false,
        loading: false,
        progress: null,
      }),
      false,
    );
  });
});

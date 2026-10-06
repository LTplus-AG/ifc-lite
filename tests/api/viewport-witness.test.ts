/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyViewportWitness, MIN_GEOMETRY_FRACTION } from '../e2e/viewport-witness.js';

const SIZE = 64;
const BACKGROUND: readonly number[] = [245, 245, 247, 255];

/** Deterministic frame: uniform background plus `painted` geometry pixels at the end. */
function frame(painted: number): { width: number; height: number; rgba: Uint8Array } {
  const rgba = new Uint8Array(SIZE * SIZE * 4);
  for (let i = 0; i < SIZE * SIZE; i++) {
    const color = i >= SIZE * SIZE - painted ? [90, 120, 160, 255] : BACKGROUND;
    rgba.set(color, i * 4);
  }
  return { width: SIZE, height: SIZE, rgba };
}

const enough = Math.ceil(SIZE * SIZE * MIN_GEOMETRY_FRACTION) + 5;

test('a frame with geometry pixels is rendered evidence, strict or not', () => {
  for (const strict of [true, false]) {
    const verdict = classifyViewportWitness({ frame: frame(enough), lossEvidence: null, strict });
    assert.equal(verdict.status, 'rendered');
    assert.equal(verdict.geometryPixels, enough);
  }
});

test('a background-only frame is a failure, never accepted as CPU-only footage', () => {
  for (const strict of [true, false]) {
    const verdict = classifyViewportWitness({ frame: frame(0), lossEvidence: null, strict });
    assert.equal(verdict.status, 'fail');
  }
});

test('a device loss fails a strict run and is declared not-established on a software host', () => {
  const lossEvidence = '[Viewport] GPU device lost: unknown A valid external Instance reference no longer exists.';
  assert.equal(classifyViewportWitness({ frame: null, lossEvidence, strict: true }).status, 'fail');
  const hosted = classifyViewportWitness({ frame: null, lossEvidence, strict: false });
  assert.equal(hosted.status, 'not-established');
  assert.match(hosted.summary, /NOT geometry acceptance/);
  assert.match(hosted.summary, /device lost/i);
});

test('a geometry frame read back after a loss means the device recovered and rendered', () => {
  const verdict = classifyViewportWitness({ frame: frame(enough), lossEvidence: 'lost', strict: false });
  assert.equal(verdict.status, 'rendered');
  assert.match(verdict.summary, /recovered/);
});

test('a missing frame without loss evidence is a failure', () => {
  assert.equal(classifyViewportWitness({ frame: null, lossEvidence: null, strict: false }).status, 'fail');
});

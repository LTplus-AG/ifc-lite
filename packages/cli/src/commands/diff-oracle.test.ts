/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Oracle harness: a known, minimal edit through a real STEP fixture, run
 * through the real `@ifc-lite/diff` engine via the CLI adapter
 * (`buildFileFingerprints`), and checked against the exactly-that-edit
 * expectation. See the mutation-diff-sweep test (#3130-style) for the sibling
 * convention; this file covers unit-of-measure cases that sweep did not.
 */

import { describe, expect, it } from 'vitest';
import { diffModels } from '@ifc-lite/diff';
import { buildFileFingerprints } from './diff-engine.js';
import { loadIfcBytes } from '../loader.js';
import { guid, quantityModel } from './diff-test-helpers.js';

describe('oracle: quantity unit-of-measure', () => {
  it('a Qto_ length quantity re-authored in a different project length unit, same physical length, classifies as unchanged', async () => {
    // Base: 2 metres, project unit METRE, raw value 2.0.
    const baseStore = await loadIfcBytes(
      new TextEncoder().encode(quantityModel('METRE', 2)),
      'base',
    );
    // Head: same 2 metres, project unit MILLIMETRE, raw value 2000.0 — same
    // building, nothing an author or coordinator would call an edit.
    const headStore = await loadIfcBytes(
      new TextEncoder().encode(quantityModel('MILLIMETRE', 2000)),
      'head',
    );

    const diff = diffModels(buildFileFingerprints(baseStore), buildFileFingerprints(headStore));
    const wall = diff.byKey.get(guid('WALL'));
    expect(wall?.state).toBe('unchanged');
  });

  it('control: a genuine quantity edit within one project unit still classifies as modified', async () => {
    const baseStore = await loadIfcBytes(
      new TextEncoder().encode(quantityModel('METRE', 2)),
      'base',
    );
    // Same unit, a real 2 m -> 3 m edit.
    const headStore = await loadIfcBytes(
      new TextEncoder().encode(quantityModel('METRE', 3)),
      'head',
    );

    const diff = diffModels(buildFileFingerprints(baseStore), buildFileFingerprints(headStore));
    const wall = diff.byKey.get(guid('WALL'));
    expect(wall?.state).toBe('modified');
    expect(wall?.changeKinds).toEqual(['data']);
  });

  it('a genuinely different physical length across a unit change still classifies as modified', async () => {
    // Base: 2 metres. Head: re-authored in millimetres AND changed to 3 m
    // (raw 3000) — a real edit riding along with the unit change.
    const baseStore = await loadIfcBytes(
      new TextEncoder().encode(quantityModel('METRE', 2)),
      'base',
    );
    const headStore = await loadIfcBytes(
      new TextEncoder().encode(quantityModel('MILLIMETRE', 3000)),
      'head',
    );

    const diff = diffModels(buildFileFingerprints(baseStore), buildFileFingerprints(headStore));
    const wall = diff.byKey.get(guid('WALL'));
    expect(wall?.state).toBe('modified');
  });

  it('uses a quantity member’s explicit Unit before the project unit assignment', async () => {
    // Both projects declare metres. The head quantity overrides that with
    // millimetres, so its raw 2000 is still the base quantity’s physical 2 m.
    const baseStore = await loadIfcBytes(
      new TextEncoder().encode(quantityModel('METRE', 2)),
      'base',
    );
    const headStore = await loadIfcBytes(
      new TextEncoder().encode(quantityModel('METRE', 2000, 'MILLIMETRE')),
      'head',
    );

    const diff = diffModels(buildFileFingerprints(baseStore), buildFileFingerprints(headStore));
    expect(diff.byKey.get(guid('WALL'))?.state).toBe('unchanged');
  });
});

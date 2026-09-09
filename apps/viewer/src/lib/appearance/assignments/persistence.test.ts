/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_APPEARANCE_SETTINGS } from '../settings.js';
import type { AppearanceAssignment } from './types.js';
import { parseAppearanceAssignments, serializeAppearanceAssignments } from './persistence.js';
import { resolveAppearanceAssignments } from './resolve.js';
const row = (): AppearanceAssignment => ({ id: 'row',
  model: { slotId: 'explicit-slot', modelId: 'old-session-model', name: 'Building', sourceSha256: 'a'.repeat(64), revision: 'old-revision' },
  source: { id: 'document', assetId: 'b'.repeat(64), name: 'Plan', width: 20, height: 10,
    pdf: { documentKey: 'source-document', recipe: { page: { pageNumber: 2, viewBox: [0, 0, 200, 100], userUnit: 1,
      intrinsicRotation: 0, widthPoints: 200, heightPoints: 100, pdfToPage: [1, 0, 0, -1, 0, 100] },
      rotation: 0, cropPoints: [0, 0, 200, 100], requestedDpi: 72, effectiveDpi: 7.2,
      pixelWidth: 20, pixelHeight: 10, paperSizeMetres: [0.07, 0.035], pixelToPdf: [10, 0, 0, -10, 0, 100] } } },
  settings: { ...DEFAULT_APPEARANCE_SETTINGS }, query: { kind: 'class', ifcClass: 'IfcWall' },
  members: [{ expressId: 10, GlobalId: 'wall' }, { expressId: 11, GlobalId: 'other-wall' }], excludedGlobalIds: ['other-wall'] });
it('saved assignment recipes preserve ordered exceptions and exact PDF derivative identity #4420', () => {
  const a = row(), b = { ...row(), id: 'second', excludedGlobalIds: ['wall'] };
  const restored = parseAppearanceAssignments(serializeAppearanceAssignments([a, b]));
  assert.deepEqual(resolveAppearanceAssignments(restored.assignments).map(r => r.productIds), [[10], [11]]);
  assert.equal(restored.assignments[0].model.modelId, 'old-session-model');
  assert.equal(restored.assignments[0].source.assetId, 'b'.repeat(64));
  assert.equal(restored.assignments[0].source.pdf?.recipe.page.pageNumber, 2);
  a.source.pdf!.recipe.pixelToPdf[0] = 99;
  assert.equal(restored.assignments[0].source.pdf?.recipe.pixelToPdf[0], 10);
});
it('untrusted assignment recipes refuse unsupported versions, nonfinite mappings and mismatched PDF dimensions #4420', () => {
  assert.throws(() => parseAppearanceAssignments('{"version":2,"assignments":[]}'), /Unsupported/);
  const a = row(); a.settings.tileWidth = Number.NaN;
  assert.throws(() => serializeAppearanceAssignments([a]), /finite numbers/);
  a.settings.tileWidth = 1; a.source.pdf!.recipe.pixelWidth = 9;
  assert.throws(() => serializeAppearanceAssignments([a]), /dimensions differ/);
  assert.throws(() => parseAppearanceAssignments(' '.repeat(4_000_001)), /4 MB/);
});

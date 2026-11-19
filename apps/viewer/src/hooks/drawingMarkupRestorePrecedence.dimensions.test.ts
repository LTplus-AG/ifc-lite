/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A localStorage entry that holds only dimensions is a markup decision: it
 * outranks the file's embedded markup exactly like an entry holding a
 * measurement does (`drawingMarkupRestorePrecedence.ts`'s
 * `outranksEmbeddedMarkup`). Treating it as "no decision" would let the
 * embedded restore run on reopen and pile the file's markup over the
 * session's own dimensions, now that dimensions are embedded too.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import type { FederatedModel } from '@/store';
import { hasPersistedMarkupEntryFor, setCachedHash } from './drawingMarkupRestorePrecedence.js';
import { clearAllDrawing2DEntries, saveDrawing2DEntry } from '@/store/slices/drawing2DSlice.persistence.js';
import { getDefaultDrawing2DState } from '@/store/slices/drawing2DSlice.js';

const DEFAULTS = getDefaultDrawing2DState().drawing2DDisplayOptions;
const EMPTY = {
  measure2DResults: [], polygonArea2DResults: [], textAnnotations2D: [], cloudAnnotations2D: [],
  drawing2DDisplayOptions: DEFAULTS, sectionConfig: null,
};

function openWithHash(modelId: string, hash: string): void {
  const file = new File([new Uint8Array([1, 2, 3])], `${modelId}.ifc`);
  useViewerStore.setState({
    models: new Map([[modelId, { id: modelId, name: file.name, sourceFile: file } as unknown as FederatedModel]]),
  } as never);
  setCachedHash(modelId, hash);
}

describe('localStorage precedence over embedded markup with dimensions', () => {
  afterEach(() => {
    clearAllDrawing2DEntries();
    useViewerStore.setState({ models: new Map() } as never);
  });

  it('an entry holding only dimensions outranks the embedded markup', () => {
    openWithHash('dims', 'hash-dims');
    saveDrawing2DEntry('hash-dims', {
      ...EMPTY,
      dimensions2D: [{ id: 'd1', a: { x: 0, y: 0 }, b: { x: 2, y: 0 }, offset: 0.5, orientation: 'aligned' }],
    });
    assert.equal(hasPersistedMarkupEntryFor('dims'), true);
  });

  it('an entry with no markup at all (dimensions included) still yields to the embedded markup', () => {
    openWithHash('blank', 'hash-blank');
    saveDrawing2DEntry('hash-blank', { ...EMPTY, dimensions2D: [] });
    assert.equal(hasPersistedMarkupEntryFor('blank'), false);
  });
});

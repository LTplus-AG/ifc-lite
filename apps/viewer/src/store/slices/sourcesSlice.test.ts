/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createStore } from 'zustand/vanilla';
import { createSourcesSlice, type SourcesSlice } from './sourcesSlice.js';
import type { SourceTag } from '@ifc-lite/plugin-api';

const makeStore = () => createStore<SourcesSlice>(createSourcesSlice);

const tag = (label: string): SourceTag => ({
  provider: 'dropbox',
  projectId: 'proj',
  containerId: 'container',
  fileId: label,
  revisionId: 'rev-1',
  loadedAt: 0,
});

describe('sourcesSlice', () => {
  describe('setSourceTag', () => {
    it('stores a tag under its model id without disturbing other models', () => {
      const s = makeStore();
      s.getState().setSourceTag('model-1', tag('one'));
      s.getState().setSourceTag('model-2', tag('two'));

      assert.deepStrictEqual(s.getState().sourceTags.get('model-1'), tag('one'));
      assert.deepStrictEqual(s.getState().sourceTags.get('model-2'), tag('two'));
      assert.strictEqual(s.getState().sourceTags.size, 2);
    });
  });

  describe('removeSourceTag', () => {
    it('removes exactly the named model, leaving unrelated tags in place', () => {
      const s = makeStore();
      s.getState().setSourceTag('model-1', tag('one'));
      s.getState().setSourceTag('model-2', tag('two'));

      s.getState().removeSourceTag('model-1');

      assert.ok(!s.getState().sourceTags.has('model-1'));
      assert.deepStrictEqual(s.getState().sourceTags.get('model-2'), tag('two'));
    });

    it('leaves the map untouched (same object identity) when the model has no tag', () => {
      // Non-default state: seed an UNRELATED tag first, so a mutant that wipes
      // the map on a miss (instead of doing nothing) is caught by content, not
      // just by the identity check below.
      const s = makeStore();
      s.getState().setSourceTag('model-2', tag('two'));
      const before = s.getState().sourceTags;

      s.getState().removeSourceTag('model-1');

      assert.strictEqual(s.getState().sourceTags, before, 'a miss must not allocate a new Map (guard must short-circuit)');
      assert.deepStrictEqual(s.getState().sourceTags.get('model-2'), tag('two'));
    });
  });

  describe('clearSourceTags', () => {
    it('empties a non-empty map', () => {
      const s = makeStore();
      s.getState().setSourceTag('model-1', tag('one'));

      s.getState().clearSourceTags();

      assert.strictEqual(s.getState().sourceTags.size, 0);
    });

    it('leaves the map untouched (same object identity) when already empty', () => {
      const s = makeStore();
      const before = s.getState().sourceTags;

      s.getState().clearSourceTags();

      assert.strictEqual(s.getState().sourceTags, before, 'clearing an already-empty map must not allocate a new one');
    });
  });

  describe('sourcesPanelVisible', () => {
    it('setSourcesPanelVisible sets the exact value given, in both directions', () => {
      const s = makeStore();
      s.getState().setSourcesPanelVisible(true);
      assert.strictEqual(s.getState().sourcesPanelVisible, true);
      s.getState().setSourcesPanelVisible(false);
      assert.strictEqual(s.getState().sourcesPanelVisible, false);
    });

    it('toggleSourcesPanel flips from either starting value', () => {
      const s = makeStore();
      assert.strictEqual(s.getState().sourcesPanelVisible, false);
      s.getState().toggleSourcesPanel();
      assert.strictEqual(s.getState().sourcesPanelVisible, true);
      s.getState().toggleSourcesPanel();
      assert.strictEqual(s.getState().sourcesPanelVisible, false);
    });
  });
});

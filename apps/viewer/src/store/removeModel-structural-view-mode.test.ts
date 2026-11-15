/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Removing the last model that holds structural analysis data must return the
 * analytical/physical mode to 'both', as clearing every model does. Otherwise
 * the mode command is disabled (no structural data) while a latched
 * 'analytical' mode masks the next physical-only model (#9957).
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { useViewerStore } from './index.js';
import type { FederatedModel } from './types.js';

function model(id: string, idOffset: number, classes: string[]): FederatedModel {
  const byType = new Map(classes.map((type, i) => [type, [i + 1]]));
  const names = new Map(classes.map((type, i) => [i + 1, type]));
  const ifcDataStore = {
    entityIndex: { byType },
    entities: { expressId: [...names.keys()], getTypeName: (id: number) => names.get(id) ?? 'Unknown' },
  };
  return { id, name: id, visible: true, idOffset, maxExpressId: 10, ifcDataStore } as unknown as FederatedModel;
}

const STRUCTURAL = 'IFCSTRUCTURALCURVEMEMBER';
const WALL = 'IFCWALL';

describe('removeModel resets the structural view mode once no structural data remains', () => {
  beforeEach(() => {
    useViewerStore.setState({ models: new Map(), mutationViews: new Map(), ifcDataStore: null, structuralViewMode: 'both' });
  });

  it('returns analytical mode to both when the last structural model is removed', () => {
    useViewerStore.setState({
      models: new Map([['S', model('S', 0, [STRUCTURAL, WALL])], ['P', model('P', 100, [WALL])]]),
      structuralViewMode: 'analytical',
    });
    useViewerStore.getState().removeModel('S');
    assert.strictEqual(useViewerStore.getState().structuralViewMode, 'both');
  });

  it('keeps the mode while another loaded model still has structural data', () => {
    useViewerStore.setState({
      models: new Map([['S1', model('S1', 0, [STRUCTURAL])], ['S2', model('S2', 100, [STRUCTURAL])]]),
      structuralViewMode: 'physical',
    });
    useViewerStore.getState().removeModel('S1');
    assert.strictEqual(useViewerStore.getState().structuralViewMode, 'physical');
  });

  it('leaves the glyph preference alone', () => {
    useViewerStore.setState({
      models: new Map([['S', model('S', 0, [STRUCTURAL])]]),
      structuralViewMode: 'analytical',
    });
    const before = useViewerStore.getState().typeVisibility.structuralGlyphs;
    useViewerStore.getState().removeModel('S');
    assert.strictEqual(useViewerStore.getState().typeVisibility.structuralGlyphs, before);
  });
});

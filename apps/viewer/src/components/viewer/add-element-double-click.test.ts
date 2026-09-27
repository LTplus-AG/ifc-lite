/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6233: the Add Element hints promise that a double-click closes a polygon
 * outline, but only Enter did. A physical double-click is `click, click,
 * dblclick`: the second click must not add a duplicate vertex, and the
 * dblclick must commit the outline exactly like Enter.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { closeAddElementPolygonFromDoubleClick, isAddElementPolygonRepeatClick } from './add-element-double-click.js';

type State = ReturnType<typeof useViewerStore.getState>;

const MODEL_ID = 'm-double-click';
const SQUARE = [
  { x: 0, y: 0, z: 0 },
  { x: 4, y: 0, z: 0 },
  { x: 4, y: 0, z: -3 },
];

describe('Add Element polygon: double-click closes the outline (#6233)', () => {
  const original = useViewerStore.getState();
  let slabs: Array<{ OuterCurve?: unknown }>;

  beforeEach(() => {
    slabs = [];
    useViewerStore.setState({
      ...fixtureModels(fixtureModel(MODEL_ID, {
        entities: [{ expressId: 1, type: 'IfcBuildingStorey' }],
      })),
      mutationViews: new Map(),
      activeTool: 'addElement',
      addElementType: 'slab',
      addElementSlabMode: 'polygon',
      addElementModelId: MODEL_ID,
      addElementStoreyId: 1,
      addElementPendingPoints: [...SQUARE],
      addSlab: (_modelId: string, _storeyId: number, params: { OuterCurve?: unknown }) => {
        slabs.push(params);
        return { expressId: 900 };
      },
    } as Partial<State>);
  });

  afterEach(() => {
    useViewerStore.setState(original, true);
  });

  it('skips the second click of a double-click instead of appending a duplicate vertex', () => {
    assert.equal(isAddElementPolygonRepeatClick({ detail: 1 }), false, 'a single click still places a vertex');
    assert.equal(isAddElementPolygonRepeatClick({ detail: 2 }), true);
    useViewerStore.setState({ addElementSlabMode: 'rectangle' });
    assert.equal(isAddElementPolygonRepeatClick({ detail: 2 }), false, 'rectangle mode keeps every click');
    useViewerStore.setState({ addElementSlabMode: 'polygon', addElementType: 'wall' });
    assert.equal(isAddElementPolygonRepeatClick({ detail: 2 }), false, 'axis types keep every click');
  });

  it('commits the pending polygon like Enter does', () => {
    assert.equal(closeAddElementPolygonFromDoubleClick(), true);
    assert.equal(slabs.length, 1, 'the double-click must add the slab');
    assert.equal((slabs[0].OuterCurve as unknown[]).length, 3);
    assert.deepEqual(useViewerStore.getState().addElementPendingPoints, []);
  });

  it('leaves the event alone outside polygon drawing', () => {
    useViewerStore.setState({ addElementPendingPoints: [] });
    assert.equal(closeAddElementPolygonFromDoubleClick(), false, 'no points placed yet');
    useViewerStore.setState({ addElementPendingPoints: [...SQUARE], addElementSlabMode: 'rectangle' });
    assert.equal(closeAddElementPolygonFromDoubleClick(), false, 'rectangle mode');
    useViewerStore.setState({ addElementSlabMode: 'polygon', activeTool: 'select' });
    assert.equal(closeAddElementPolygonFromDoubleClick(), false, 'another tool');
    assert.equal(slabs.length, 0);
  });
});

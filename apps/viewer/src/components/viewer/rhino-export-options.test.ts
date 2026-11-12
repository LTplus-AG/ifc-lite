/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the Rhino dialog sends the scene builder. The builder deserializes with
 * `deny_unknown_fields` (`rust/export/src/rhino/options.rs`), so a stray field
 * fails the export; and `isolated: []` must stay an active filter, never
 * collapse to "no filter" (#4328).
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store/index.js';
import type { FederatedModel } from '@/store/types.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import {
  DEFAULT_RHINO_EXPORT_SETTINGS,
  resolveRhinoVisibility,
  rhinoSceneOptions,
} from './rhino-export-options.js';

const RUST_FIELDS = new Set([
  'units', 'coordinates', 'layerScheme', 'instancing', 'properties', 'includeSpaces',
  'normals', 'layerSlicing', 'hidden', 'isolated', 'hiddenTypes',
]);

describe('rhinoSceneOptions', () => {
  it('defaults to the spec defaults and sends no visibility filter', () => {
    assert.deepEqual(rhinoSceneOptions(DEFAULT_RHINO_EXPORT_SETTINGS), {
      units: 'source',
      coordinates: 'local',
      layerScheme: 'spatial-class',
      instancing: true,
      properties: 'all',
      includeSpaces: true,
    });
  });

  it('ignores the viewer visibility unless "only visible" is on', () => {
    const visibility = { hidden: [3], isolated: [4] };
    const options = rhinoSceneOptions(DEFAULT_RHINO_EXPORT_SETTINGS, visibility);
    assert.equal('hidden' in options, false);
    assert.equal('isolated' in options, false);
    assert.equal('hiddenTypes' in options, false);
  });

  it('keeps an empty isolation as an active filter, and only sends fields Rust knows', () => {
    const options = rhinoSceneOptions(
      { ...DEFAULT_RHINO_EXPORT_SETTINGS, visibleOnly: true, units: 'millimeters', coordinates: 'world' },
      { hidden: [], isolated: [] },
    );
    assert.deepEqual(options.isolated, [], 'empty isolation is not "no filter"');
    assert.equal(options.units, 'millimeters');
    assert.equal(options.coordinates, 'world');
    for (const key of Object.keys(options)) assert.ok(RUST_FIELDS.has(key), `unknown field ${key}`);
    // The 3dm version is an adapter option, never a scene option.
    assert.equal('version' in options, false);
  });
});

describe('resolveRhinoVisibility', () => {
  afterEach(() => {
    useViewerStore.setState({
      models: new Map(), activeModelId: null, hiddenEntities: new Set(), isolatedEntities: null,
    });
  });

  function seed(): void {
    const model = {
      ...fixtureModel('B', {
        idOffset: 100,
        entities: [
          { expressId: 5, type: 'IfcWall' },
          { expressId: 6, type: 'IfcWall' },
          { expressId: 7, type: 'IfcSpace' },
        ],
      }),
      maxExpressId: 10,
    } as FederatedModel;
    useViewerStore.setState(fixtureModels(model));
  }

  it('maps global hidden/isolated ids to this model\'s local express ids', () => {
    seed();
    const { typeVisibility } = useViewerStore.getState();
    // Spaces shown, so only the manual hide channel contributes here.
    // 105 is model B's #5; 900 is past its id range and must not leak in.
    useViewerStore.setState({
      typeVisibility: { ...typeVisibility, spaces: true },
      hiddenEntities: new Set([105, 900]),
      isolatedEntities: new Set([105, 106]),
    });
    const visibility = resolveRhinoVisibility(useViewerStore.getState(), 'B');
    assert.deepEqual(visibility.hidden, [5]);
    assert.deepEqual([...(visibility.isolated ?? [])].sort(), [5, 6]);
  });

  it('reports no isolation as null and folds hidden classes into element ids', () => {
    seed();
    const state = useViewerStore.getState();
    useViewerStore.setState({ typeVisibility: { ...state.typeVisibility, spaces: false } });
    const visibility = resolveRhinoVisibility(useViewerStore.getState(), 'B');
    assert.equal(visibility.isolated, null);
    assert.equal('hiddenTypes' in visibility, false);
    // The hidden Spaces toggle also reaches the space itself, so a visible-only
    // export leaves it out even with "Include spaces" on.
    assert.deepEqual(visibility.hidden, [7]);
  });
});

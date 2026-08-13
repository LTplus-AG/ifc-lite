/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The footprint add/remove pair, split out of LocationMap.tsx and tested for
 * the first time. What matters is that they are a matched pair: MapLibre
 * throws on `addSource`/`addLayer` for an id that already exists, and the
 * Location panel re-runs this on every style toggle and every georef edit. A
 * source left behind, or an add that does not notice one, breaks the map on
 * the second pass rather than the first.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Feature } from 'geojson';
import {
  addFootprintToMap,
  removeFootprintFromMap,
  FOOTPRINT_SOURCE,
  FOOTPRINT_FILL_LAYER,
  FOOTPRINT_OUTLINE_LAYER,
  type FootprintMap,
} from './location-map-footprint.js';

const RING: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 0]];

/** A MapLibre stand-in that throws on duplicate add, exactly as the real one does. */
function fakeMap() {
  const sources = new Map<string, { setData(d: Feature): void; data: Feature | null }>();
  const layers = new Map<string, unknown>();
  const map = {
    sources,
    layers,
    getSource(id: string) { return sources.get(id); },
    addSource(id: string, source: { data?: unknown }) {
      if (sources.has(id)) throw new Error(`source ${id} already exists`);
      const entry = {
        data: (source.data as Feature) ?? null,
        setData(d: Feature) { entry.data = d; },
      };
      sources.set(id, entry);
    },
    addLayer(layer: { id: string }) {
      if (layers.has(layer.id)) throw new Error(`layer ${layer.id} already exists`);
      layers.set(layer.id, layer);
    },
    getLayer(id: string) { return layers.get(id); },
    removeLayer(id: string) { layers.delete(id); },
    removeSource(id: string) {
      // MapLibre refuses to drop a source that layers still reference. Without
      // this, a regression that removed the source BEFORE its layers would pass
      // every assertion here and throw on the real map.
      for (const layer of layers.values()) {
        if ((layer as { source?: string }).source === id) {
          throw new Error(`source ${id} is still in use by a layer`);
        }
      }
      sources.delete(id);
    },
  };
  return map;
}

/** The fake is structurally compatible; the casts keep the test literals loose. */
const asMap = (m: ReturnType<typeof fakeMap>) => m as unknown as FootprintMap;

describe('location-map footprint', () => {
  it('adds the source and both layers on first use', () => {
    const m = fakeMap();

    addFootprintToMap(asMap(m), RING);

    assert.ok(m.sources.has(FOOTPRINT_SOURCE));
    assert.deepEqual([...m.layers.keys()].sort(), [FOOTPRINT_FILL_LAYER, FOOTPRINT_OUTLINE_LAYER].sort());
  });

  it('updates the existing source instead of adding it twice', () => {
    const m = fakeMap();
    addFootprintToMap(asMap(m), RING);

    const moved: [number, number][] = [[10, 10], [11, 10], [11, 11], [10, 10]];
    // The real map throws on a duplicate addSource; this must not reach it.
    addFootprintToMap(asMap(m), moved);

    const geo = m.sources.get(FOOTPRINT_SOURCE)!.data as Feature;
    assert.deepEqual((geo.geometry as { coordinates: unknown }).coordinates, [moved]);
    assert.equal(m.layers.size, 2, 'layers are not duplicated either');
  });

  it('removes every source and layer it added, so a re-add is clean', () => {
    const m = fakeMap();
    addFootprintToMap(asMap(m), RING);

    removeFootprintFromMap(asMap(m));

    assert.equal(m.sources.size, 0);
    assert.equal(m.layers.size, 0);
    // The pairing is the point: a leftover would throw here.
    assert.doesNotThrow(() => addFootprintToMap(asMap(m), RING));
  });

  it('removes the layers BEFORE the source they reference', () => {
    // The fake throws on a source still referenced by a layer, exactly as
    // MapLibre does, so reversing the order in removeFootprintFromMap fails
    // here rather than only on a real map.
    const m = fakeMap();
    addFootprintToMap(asMap(m), RING);

    assert.doesNotThrow(() => removeFootprintFromMap(asMap(m)));
  });

  it('is a no-op when there is nothing to remove', () => {
    const m = fakeMap();

    assert.doesNotThrow(() => removeFootprintFromMap(asMap(m)));
  });

  it('draws the ring it was given', () => {
    const m = fakeMap();

    addFootprintToMap(asMap(m), RING);

    const geo = m.sources.get(FOOTPRINT_SOURCE)!.data as Feature;
    assert.equal(geo.type, 'Feature');
    assert.equal((geo.geometry as { type: string }).type, 'Polygon');
    assert.deepEqual((geo.geometry as { coordinates: unknown }).coordinates, [RING]);
  });
});

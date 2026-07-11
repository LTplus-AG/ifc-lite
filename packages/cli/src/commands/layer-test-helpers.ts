/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Shared fixtures for the `layer` / `ref` command test suites. */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IfcxFile, IfcxNode } from '@ifc-lite/ifcx';
import { openStore, type LayerStore } from './layer-store.js';
import { publishLayer } from './layer-publish.js';
import { createRef, moveRef } from './ref.js';

export const FIRE = 'bsi::ifc::v5a::Pset_FireSafety::FireRating';
export const CLASS = 'bsi::ifc::class';

export function tmpStore(): LayerStore {
  return openStore(mkdtempSync(join(tmpdir(), 'ifc-lite-layer-test-')));
}

export function makeDelta(nodes: IfcxNode[]): IfcxFile {
  return {
    header: {
      id: '',
      ifcxVersion: 'ifcx_alpha',
      dataVersion: '1.0.0',
      author: 'test',
      timestamp: '2026-01-01T00:00:00.000Z',
    },
    imports: [],
    schemas: {},
    data: nodes,
  };
}

export const baseNodes: IfcxNode[] = [
  { path: 'storey-eg', children: { Wall: 'wall-1' } },
  {
    path: 'wall-1',
    attributes: { [CLASS]: { code: 'IfcWall', uri: 'u' }, [FIRE]: 'REI60' },
  },
];

/** Publish a base layer and point a fresh ref `main` at it. */
export function setupMain(store: LayerStore): string {
  const published = publishLayer(store, {
    delta: makeDelta(baseNodes),
    baseRef: null,
    intent: 'Import base model',
    principal: 'alice',
  });
  createRef(store, 'main');
  moveRef(store, 'main', published.layerId);
  return published.layerId;
}

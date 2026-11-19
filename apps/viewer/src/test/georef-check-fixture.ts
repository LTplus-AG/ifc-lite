/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `@ifc-lite/georef-check`'s committed fixtures as parsed models, seeded as
 * viewer model `m` (#10608): the Georeference panel tests render against them.
 */

import { readFileSync } from 'node:fs';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from './store-fixture';

const FIXTURES = new URL('../../../../packages/georef-check/fixtures/', import.meta.url);

/** Parse IFC bytes the way the viewer does, off the worker scan (copies only the view's own range). */
export async function parseIfcBytes(bytes: Uint8Array): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { disableWorkerScan: true });
}

/** One fixture, e.g. `height-in-millimetres`. */
export async function georefCheckFixture(name: string): Promise<IfcDataStore> {
  return parseIfcBytes(readFileSync(new URL(`${name}.ifc`, FIXTURES)));
}

/** Make `store` the viewer's model `m`, editable, with no georeference edits. */
export function seedGeorefModel(store: IfcDataStore): void {
  useViewerStore.setState({
    ...fixtureModels({ ...fixtureModel('m'), ifcDataStore: store }),
    editEnabled: true,
    georefMutations: new Map(),
  });
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The committed buildingSMART sample (authored in SketchUp with IFC-manager,
 * millimetre length unit) and its demo IDS, installed as one editable model
 * for the P15 correction tests. Real authoring-tool data: walls carry
 * `Qto_WallBaseQuantities` in mm and each wall type shares its occurrence's Name.
 */

import { readFile } from 'node:fs/promises';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { fixtureModel } from './store-fixture';

const SAMPLE_IFC = new URL('../../public/samples/building-architecture.ifc', import.meta.url);
const SAMPLE_IDS = new URL('../../public/samples/building-architecture.ids', import.meta.url);

export const SAMPLE_WALLS = {
  rightFront: '1AQAupaRP1txwK1AGiN61V',
  rightBack: '3wdauVJT5Fx9drrREiDqA$',
  left: '0OfZwWc8j9QP5uX8xPTxDH',
  plumbing: '1uS5vfZPn9R8PlAaVd73on',
} as const;

export async function parseIfcBytes(bytes: Uint8Array): Promise<IfcDataStore> {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new IfcParser().parseColumnar(buffer, { disableWorkerScan: true });
}

export async function sampleIdsXml(): Promise<string> {
  return readFile(SAMPLE_IDS, 'utf8');
}

/** Install the sample as model `modelId` with a live mutation view and empty history. */
export async function installSampleModel(modelId = 'sample', editEnabled = true) {
  const data = await parseIfcBytes(new Uint8Array(await readFile(SAMPLE_IFC)));
  const view = new MutablePropertyView(data.properties, modelId);
  const { configureMutationView } = await import('@/utils/configureMutationView');
  configureMutationView(view, data);
  useViewerStore.setState({
    models: new Map([[modelId, { ...fixtureModel(modelId), ifcDataStore: data }]]), activeModelId: modelId, ifcDataStore: data,
    mutationViews: new Map([[modelId, view]]), undoStacks: new Map(), redoStacks: new Map(), mutationBatchTags: new Map(),
    dirtyModels: new Set(), editEnabled, collabRole: null, collabRoomId: null, mutationVersion: 0, idsValidationReport: null,
  });
  return { data, view };
}

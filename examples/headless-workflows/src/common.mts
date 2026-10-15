/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { openModel, type HeadlessModelSession, type OpenModelOptions } from '@ifc-lite/sdk/headless';

export class IncompleteModelError extends Error {
  readonly code = 'INCOMPLETE_SCAN';
  constructor() { super('Record coverage is incomplete or unknown; refusing to report a whole-model result'); }
}

export async function withModelBytes<T>(bytes: Uint8Array, action: (model: HeadlessModelSession) => T | Promise<T>, options: OpenModelOptions = {}): Promise<T> {
  const model = await openModel(bytes, { disableWorkerScan: true, ...options });
  try {
    if (model.report.completeness !== 'complete') throw new IncompleteModelError();
    return await action(model);
  } finally { model.close(); }
}

export async function withModelFile<T>(path: string, action: (model: HeadlessModelSession) => T | Promise<T>): Promise<T> {
  return withModelBytes(await readFile(path), action, { modelName: basename(path) });
}

export function doorRows(model: HeadlessModelSession) {
  return model.bim.query().byType('IfcDoor').toArray().map(door => ({
    ref: door.ref, GlobalId: door.globalId, Name: door.name,
    FireRating: model.bim.property(door.ref, 'Pset_DoorCommon', 'FireRating'),
  }));
}

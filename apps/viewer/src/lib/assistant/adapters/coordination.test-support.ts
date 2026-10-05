/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Real parsed sample shared by the coordination adapter tests (#6833). */

import { readFile } from 'node:fs/promises';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import type { FederatedModel } from '@/store';

let parsed: Promise<IfcDataStore> | null = null;

/** `building-architecture.ifc`, a committed authored model, parsed once per test file. */
export function architectureSample(): Promise<IfcDataStore> {
  parsed ??= readFile(new URL('../../../../public/samples/building-architecture.ifc', import.meta.url))
    .then(bytes => new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      { disableWorkerScan: true }));
  return parsed;
}

export function sampleModel(id: string, store: IfcDataStore, idOffset: number): FederatedModel {
  return {
    id, name: `${id}.ifc`, ifcDataStore: store, geometryResult: null, visible: true, collapsed: false,
    schemaVersion: 'IFC4', loadedAt: 0, fileSize: 0, idOffset,
    maxExpressId: Math.max(...store.entityIndex.byId.keys()), sourceFingerprint: `fingerprint-${id}`,
  };
}

/** Express ids of one IFC type in file order. */
export function idsOfType(store: IfcDataStore, type: string): number[] {
  return [...(store.entityIndex.byType.get(type.toUpperCase()) ?? [])];
}

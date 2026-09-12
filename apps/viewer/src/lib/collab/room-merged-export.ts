/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MergeModelInput } from '@ifc-lite/export';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { roomStepExportSource, type RoomStepExportSource } from './room-step-export';
import { roomSymbolicSource } from './room-symbolic-source';

export function roomMergeInput(options: {
  id: string;
  name: string;
  store: IfcDataStore;
  roomView?: MutablePropertyView;
  applyMutations: boolean;
}): { input: MergeModelInput; portable?: RoomStepExportSource } {
  const portable = roomStepExportSource(options.store, options.roomView, options.id);
  if (roomSymbolicSource(options.store) && !portable) {
    throw new Error(`Shared model "${options.name}" cannot be merged as STEP after its root set changed. Export it separately.`);
  }
  if (portable?.resources?.resources.size) {
    throw new Error(`Shared model "${options.name}" carries texture resources. Export it separately as IFCZIP.`);
  }
  return {
    input: {
      id: options.id,
      name: options.name,
      dataStore: portable?.dataStore ?? options.store,
      mutationView: options.applyMutations ? (portable?.mutationView ?? options.roomView) : undefined,
    },
    portable: portable ?? undefined,
  };
}

export function roomMergeVisibility(
  modelIds: Iterable<string>,
  portableByModel: ReadonlyMap<string, RoomStepExportSource>,
  hiddenFor: (modelId: string) => Set<number>,
  isolatedFor: (modelId: string) => Set<number> | null,
): { hidden: Map<string, Set<number>>; isolated: Map<string, Set<number> | null> } {
  const hidden = new Map<string, Set<number>>();
  const isolated = new Map<string, Set<number> | null>();
  for (const id of modelIds) {
    const portable = portableByModel.get(id);
    hidden.set(id, portable?.toSourceIds(hiddenFor(id)) ?? hiddenFor(id));
    const selected = isolatedFor(id);
    isolated.set(id, portable?.toSourceIds(selected) ?? selected);
  }
  return { hidden, isolated };
}

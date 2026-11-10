/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StateCreator } from 'zustand';
import type { FederatedModel } from '../types.js';
import type { Run } from '@/lib/runs/run';
import { defineSliceTeardown } from '../teardown.js';

export interface ServerPropertiesOwner {
  model: FederatedModel;
  isStale?: () => boolean;
}
export type ServerPropertiesRun = Run<void, never, ServerPropertiesOwner, string>;

export interface ServerPropertiesSlice {
  serverPropertiesRuns: ReadonlyMap<string, ServerPropertiesRun>;
  setServerPropertiesRun(modelId: string, run: ServerPropertiesRun): void;
  clearServerPropertiesRuns(): void;
}

export const serverPropertiesTeardown = defineSliceTeardown('serverPropertiesSlice', ['serverPropertiesRuns'], {
  'session-reset': () => ({ serverPropertiesRuns: new Map() }),
  'all-models-cleared': () => ({ serverPropertiesRuns: new Map() }),
  'model-removed': (scope, state) => {
    const runs = new Map(state.serverPropertiesRuns);
    runs.delete(scope.modelId);
    return { serverPropertiesRuns: runs };
  },
});

export const createServerPropertiesSlice: StateCreator<ServerPropertiesSlice, [], [], ServerPropertiesSlice> = (set) => ({
  serverPropertiesRuns: new Map(),
  setServerPropertiesRun: (modelId, run) => set(state => {
    const runs = new Map(state.serverPropertiesRuns);
    if (run.kind === 'idle') runs.delete(modelId);
    else runs.set(modelId, run);
    return { serverPropertiesRuns: runs };
  }),
  clearServerPropertiesRuns: () => set({ serverPropertiesRuns: new Map() }),
});

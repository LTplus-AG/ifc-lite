/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StateCreator } from 'zustand';
import type { FederatedModel } from '../types.js';
import type { Run } from '@/lib/runs/run';

export interface ServerPropertiesOwner {
  model: FederatedModel;
  isStale?: () => boolean;
}
export type ServerPropertiesRun = Run<void, never, ServerPropertiesOwner, string>;

export interface ServerPropertiesSlice {
  serverPropertiesRuns: ReadonlyMap<string, ServerPropertiesRun>;
  setServerPropertiesRun(modelId: string, run: ServerPropertiesRun): void;
}

export const createServerPropertiesSlice: StateCreator<ServerPropertiesSlice, [], [], ServerPropertiesSlice> = (set) => ({
  serverPropertiesRuns: new Map(),
  setServerPropertiesRun: (modelId, run) => set(state => {
    const runs = new Map(state.serverPropertiesRuns);
    if (run.kind === 'idle') runs.delete(modelId);
    else runs.set(modelId, run);
    return { serverPropertiesRuns: runs };
  }),
});

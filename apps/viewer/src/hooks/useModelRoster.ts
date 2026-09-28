/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';

export interface ModelRosterEntry {
  name: string;
  ifcDataStore: IfcDataStore | null;
}

/**
 * The loaded models' ids, names and data stores, and nothing else (#6232 perf).
 *
 * `models` changes identity on every geometry update (a streamed batch, a
 * re-meshed element), so a component that only lists models or reads their
 * data stores re-rendered on each one. This re-renders only when a model is
 * added, removed or renamed, or its data store is replaced.
 */
export function useModelRoster(): ReadonlyMap<string, ModelRosterEntry> {
  const flat = useViewerStore(useShallow((s) => {
    const out: Array<string | IfcDataStore | null> = [];
    for (const [id, model] of s.models) out.push(id, model.name, model.ifcDataStore);
    return out;
  }));
  return useMemo(() => {
    const roster = new Map<string, ModelRosterEntry>();
    for (let i = 0; i < flat.length; i += 3) {
      roster.set(flat[i] as string, { name: flat[i + 1] as string, ifcDataStore: flat[i + 2] as IfcDataStore | null });
    }
    return roster;
  }, [flat]);
}

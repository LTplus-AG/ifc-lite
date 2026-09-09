/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ProfileEntry } from '@ifc-lite/drawing-2d';
import type { IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore, type ViewerState } from '@/store';
import { displayedTranslation } from './state';
import { toRenderTranslation } from './translation';

/** Keep cached IFC profiles in their source frame. Projection consumes a placed
 * matrix just like body geometry, including moves across projection bands. */
export function placedConstructionProfiles(profiles: ProfileEntry[], source: IfcDataStore | null, state: ViewerState = useViewerStore.getState()): ProfileEntry[] {
  const owner = [...state.models].find(([, model]) => model.ifcDataStore === source)?.[0];
  if (!owner || !source) return profiles;
  const delta = toRenderTranslation(displayedTranslation(state.modelPlacement, owner));
  if (delta.every((value) => value === 0)) return profiles;
  return profiles.map((profile) => {
    const transform = profile.transform.slice();
    for (let axis = 0; axis < 3; axis++) transform[12 + axis] += delta[axis];
    return { ...profile, transform };
  });
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { create } from 'zustand';
export interface LayerAutomationReview { id: string; candidateId: string; refName: string; action: 'merge' | 'review' | 'comment'; entity: string; title: string; description: string; withViewpoint: boolean }
/** Exact candidate configuration for existing native registry approval buttons; never performs a remote write. */
export const useLayerAutomationReview = create<{ candidate: LayerAutomationReview | null }>(() => ({ candidate: null }));

const applied = new Set<string>();
/** True the first time a Layers section adopts a candidate, so reopening the panel never re-applies it over the user's later choices. */
export function claimLayerAutomationReview(candidate: LayerAutomationReview, section: 'merge' | 'review'): boolean {
  const key = `${section}:${candidate.id}`;
  if (applied.has(key)) return false;
  applied.add(key);
  return true;
}

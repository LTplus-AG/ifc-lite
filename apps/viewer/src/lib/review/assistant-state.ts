/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { create } from 'zustand';
import type { AdapterCapture } from '../assistant/adapters/types';
import type { CoordinationCard } from './cards';

/** Readiness stays eager; pinning from the Review panel supplies its bounded projector. */
export const useReviewAssistantCard = create<{
  card: CoordinationCard | null;
  project: ((limit: number) => AdapterCapture) | null;
}>(() => ({ card: null, project: null }));

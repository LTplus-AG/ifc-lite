/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { create } from 'zustand';
import type { ArtifactSource, OciHandoff } from './handoff-contract';
import type { ResourceSession } from './handoff-auth';
interface HandoffWorkspace { handoff?: OciHandoff; sourceSession?: ResourceSession; loadedModelId?: string; saved?: ArtifactSource; destinationSession?: ResourceSession }
/** Tokens and opened content remain in this tab's memory. */
export const useHandoffWorkspace = create<HandoffWorkspace>(() => ({}));

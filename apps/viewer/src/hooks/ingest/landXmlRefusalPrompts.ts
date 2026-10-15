/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The two LandXML refusals a user can answer with an explicit choice, and the
 * retry each one offers: a unit for a source with no `<Units>` (#5175), and
 * georeferencing assumptions for a federation that could not be aligned
 * (`landXmlGeorefAssumptions.ts`). Both prompts share one lifecycle: cleared
 * when a load starts, published only for the failure their choice can fix.
 */

import { useViewerStore } from '../../store/index.js';
import type { ModelLoadOptions } from '../modelLoadOptions.js';
import { landXmlAssumptionRefusalFrom } from './landXmlGeorefAssumptions.js';
import { landXmlUnitsRefusalPrompt } from './landXmlUnitsRefusal.js';

/** What a prompt's retry adds to the original load options. */
export type LandXmlRefusalRetryOptions = Pick<ModelLoadOptions, 'assumedLinearUnit' | 'landXmlAssumptions'>;

/** A fresh load attempt (a prompt's own retry included) supersedes whatever refusal prompted it. */
export function clearLandXmlRefusalPrompts(): void {
  const state = useViewerStore.getState();
  state.setLandXmlUnitsRefusal(null);
  state.setLandXmlAssumptionRefusal(null);
}

/**
 * Publish the prompt (if any) a failed LandXML load can be answered with.
 * Each is null for any failure its choice cannot fix, so an unrelated
 * failure clears both.
 */
export function publishLandXmlRefusalPrompts(
  message: string,
  error: unknown,
  fileName: string,
  retry: (options: LandXmlRefusalRetryOptions) => void,
): void {
  const state = useViewerStore.getState();
  state.setLandXmlUnitsRefusal(landXmlUnitsRefusalPrompt(message, fileName, (assumedLinearUnit) => retry({ assumedLinearUnit })));
  state.setLandXmlAssumptionRefusal(landXmlAssumptionRefusalFrom(error, fileName, (landXmlAssumptions) => retry({ landXmlAssumptions })));
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TessellationQuality } from '@ifc-lite/geometry';

export interface ModelLoadOptions {
  sourceHandle?: FileSystemFileHandle;
  workflowOwner?: string;
  // Auto-retry-at-lower-detail (resource-retry.ts): when a resource-limit
  // failure re-invokes loadFile, it forces this tier and marks the attempt
  // so a second failure surfaces instead of looping.
  tierOverride?: TessellationQuality;
  isResourceRetry?: boolean;
  // #5175: a LandXML source with no declared `<Units>` refuses by
  // default. The viewer supplies this only after the user picks a
  // linear unit from the refusal prompt; never inferred or defaulted.
  assumedLinearUnit?: string;
}

/** Federation placement/display options share loader ownership and source handles. */
export interface FederationAddModelOptions extends Pick<ModelLoadOptions, 'sourceHandle' | 'workflowOwner'> {
  name?: string;
  modelId?: string;
  loadedAt?: number;
  visible?: boolean;
  collapsed?: boolean;
}

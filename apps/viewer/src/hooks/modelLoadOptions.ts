/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TessellationQuality } from '@ifc-lite/geometry';
import type { LandXmlGeorefAssumptions } from './ingest/landXmlGeorefAssumptions.js';

/** Terminal Gaussian load result; publication alone is not completion. */
export type GaussianLoadOutcome = 'completed' | 'cancelled' | 'failed';

export interface ModelLoadOptions {
  sourceHandle?: FileSystemFileHandle;
  /** Retry the owning operation (e.g. replacement), including its commit/cleanup. */
  retryOperation?: () => void;
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
  // The LandXML georeferencing assumptions for THIS load (the refusal
  // prompt's retry). Absent: the user's standing settings
  // (`landXmlGeorefAssumptionSettings`) apply. Never inferred.
  landXmlAssumptions?: LandXmlGeorefAssumptions;
  // Caller placement after the chosen axis conversion, before automatic IFC
  // origin subtraction. An explicit matrix without gaussianUpAxis retains its
  // own axis mapping (Y-up). No units or survey registration are inferred.
  gaussianUpAxis?: 'z' | 'y';
  gaussianPlacement?: readonly number[];
  gaussianAttribution?: string;
  /** Internal reload: reserve against the scene excluding this source model. */
  gaussianReplacingModelId?: string;
  /** Transfer the reload hold to the swap transaction, including post-publication metadata. */
  onGaussianBudgetReserved?: (release: () => void) => void;
  /** Report settlement after awaited Gaussian source metadata, including cancellation. */
  onGaussianLoadSettled?: (outcome: GaussianLoadOutcome) => void;
}

/** Federation placement/display options share loader ownership and source handles. */
export interface FederationAddModelOptions extends Pick<ModelLoadOptions, 'sourceHandle' | 'retryOperation' | 'workflowOwner' | 'gaussianPlacement' | 'gaussianUpAxis' | 'gaussianAttribution' | 'gaussianReplacingModelId' | 'onGaussianBudgetReserved' | 'onGaussianLoadSettled'> {
  name?: string;
  modelId?: string;
  loadedAt?: number;
  visible?: boolean;
  collapsed?: boolean;
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TessellationQuality } from '@ifc-lite/geometry';
import type { LandXmlGeorefAssumptions } from './ingest/landXmlGeorefAssumptions.js';
import type { GaussianQualification } from './ingest/gaussianAdmissionPolicy.js';

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
  // #8565: explicit internal Gaussian opt-in for test/showcase callers only.
  // Public entry points never pass it; see `resolveGaussianQualification`.
  gaussianQualification?: GaussianQualification;
  // Caller/user-supplied capture placement (column-major source -> viewer
  // world) and credit. Never inferred from file contents.
  gaussianPlacement?: readonly number[];
  gaussianAttribution?: string;
}

/** Federation placement/display options share loader ownership and source handles. */
export interface FederationAddModelOptions extends Pick<ModelLoadOptions, 'sourceHandle' | 'retryOperation' | 'workflowOwner' | 'gaussianPlacement' | 'gaussianAttribution'> {
  name?: string;
  modelId?: string;
  loadedAt?: number;
  visible?: boolean;
  collapsed?: boolean;
}

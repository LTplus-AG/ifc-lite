/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TessellationQuality } from '@ifc-lite/geometry';
import type { ProcessedModelSource } from '@/lib/processed-model';
import type { LandXmlGeorefAssumptions } from './ingest/landXmlGeorefAssumptions.js';

/** Terminal Gaussian load result; publication alone is not completion. */
export type GaussianLoadOutcome = 'completed' | 'cancelled' | 'failed';

export interface ModelLoadOptions {
  /**
   * Open a model the processing server has already processed, named by the
   * SHA-256 of its source file. The `File` passed alongside carries the display
   * name only: no source bytes are read, hashed, cached or uploaded, and there
   * is no local fallback. Primary target only.
   */
  processedModel?: ProcessedModelSource;
  sourceHandle?: FileSystemFileHandle;
  /** Synchronous guard that may abort a primary load before it commits to replacing the scene. */
  beforePrimaryReset?: () => void;
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
  /** THIS load's user-visible failure message; the store's `error` may belong to another load by the time the caller reads it. */
  onLoadError?: (message: string) => void;
  /** A federated target: THIS load registered its model (another load may reuse an explicit id). */
  onModelRegistered?: () => void;
  /** A site-context model loaded by the panel's fetch run (absent for a dropped site-context GLB). */
  siteContextArrival?: SiteContextArrival;
}

/** Which fetch run a site-context load belongs to, so the one arrival step can tell a live run from a cancelled one. */
export interface SiteContextArrival {
  /** The run's identity in the slice (`siteContextAbort`). */
  run: AbortController;
  /** The model the site context was fetched around. */
  anchorModelId: string;
  /** False once the run was cancelled, replaced or detached: its model is then not adopted. */
  isCurrent(): boolean;
}

/** Federation placement/display options share loader ownership and source handles. */
export interface FederationAddModelOptions extends Pick<ModelLoadOptions, 'siteContextArrival' | 'sourceHandle' | 'retryOperation' | 'workflowOwner' | 'gaussianPlacement' | 'gaussianUpAxis' | 'gaussianAttribution' | 'gaussianReplacingModelId' | 'onGaussianBudgetReserved' | 'onGaussianLoadSettled'> {
  name?: string;
  modelId?: string;
  loadedAt?: number;
  visible?: boolean;
  collapsed?: boolean;
  /** Why THIS add failed (load or federation error); never another overlapping load's. Not called on cancel. */
  onError?: (message: string) => void;
  /**
   * A replacement transaction (Gaussian reload, #8566): a newer add that starts
   * before this one settles cancels it, so it resolves `null` even if its model
   * registered. The caller owns cleanup of that model by its explicit id.
   */
  failIfSuperseded?: boolean;
}

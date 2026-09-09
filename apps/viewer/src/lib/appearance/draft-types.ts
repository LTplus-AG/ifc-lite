/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { PdfRasterRecipe } from './pdf/types.js';
import type { RasterCalibration, RasterCalibrationFrame } from './raster-calibration.js';

export type AppearanceIntent = 'apply' | 'reference' | 'capture';

export type AppearanceScope =
  | { kind: 'model' | 'selection' }
  | { kind: 'class'; ifcClass: string }
  | { kind: 'type'; typeId: number };

/** Editable display values; the controller converts degrees/axes to canonical requests. */
export interface AppearanceDraftSettings {
  kind: 'existingUv' | 'planar' | 'box';
  /** Explicit opt-in; omitted drafts preserve the original representation. */
  representationPolicy?: 'preserve' | 'evaluatedOccurrence';
  plane: 'xy' | 'xz' | 'yz';
  repeatU: number;
  repeatV: number;
  tileWidth: number;
  tileHeight: number;
  tileDepth: number;
  rotationDegrees: number;
  /** UV cycles in existingUv mode; metres in planar/box mode. */
  offsetU: number;
  offsetV: number;
  offsetW: number;
  repeatS: boolean;
  repeatT: boolean;
}
export interface AppearanceSourceOption {
  /** Session source identity. Images use their digest; PDFs keep document identity. */
  id: string;
  /** Encoded derivative identity; independent from the source's page/calibration recipe. */
  assetId?: string;
  /** Measured landmarks in the source native frame, shared across placement intents. */
  calibration?: RasterCalibration;
  /** Frozen derivative frame when restoring a registered raster without its document. */
  calibrationFrame?: RasterCalibrationFrame;
  pdf?: {
    documentKey: string;
    recipe: PdfRasterRecipe;
  };
  name: string;
  width: number;
  height: number;
  /** Session catalog-owned URL, revoked when its source is removed. */
  thumbnailUrl?: string;
}
/** Logical draft only. GPU resources, plans and pending jobs are never stored. */
export interface AppearanceDraftRecipe {
  intent?: AppearanceIntent;
  modelId: string | null;
  sourceId: string | null;
  scope: AppearanceScope;
  settings: AppearanceDraftSettings;
  previewEnabled: boolean;
}

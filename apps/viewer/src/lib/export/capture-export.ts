/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { FederatedModel } from '@/store/types';

/**
 * Gaussian captures are never exported (#8568). A capture's model carries an
 * empty synthetic data store and no meshes, so an exporter that walked it
 * would silently write an empty model or nothing at all. Model lists offered
 * by export dialogs leave captures out, and every export dialog says so
 * (`CaptureExportNotice` in `ExportDialogShell`).
 */
export function isCaptureModel(model: Pick<FederatedModel, 'gaussianSplat'>): boolean {
  return model.gaussianSplat !== undefined;
}

/** The models an exporter may walk: every loaded model except captures. */
export function exportableModels(models: ReadonlyMap<string, FederatedModel>): FederatedModel[] {
  return [...models.values()].filter((model) => !isCaptureModel(model));
}

/** How many loaded captures an export leaves out. */
export function omittedCaptureCount(models: ReadonlyMap<string, FederatedModel>): number {
  let count = 0;
  for (const model of models.values()) if (isCaptureModel(model)) count++;
  return count;
}

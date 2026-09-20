/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { DeviceRecoveryResult } from '@ifc-lite/renderer';
import { posthog } from '@/lib/analytics';
import { useViewerStore } from '@/store';
import type { FederatedModel } from '@/store/types';

export function modelsWithoutOmittedPointCloudHandles(
  result: DeviceRecoveryResult,
  models: ReadonlyMap<string, FederatedModel>,
): Map<string, FederatedModel> | null {
  if (!result.ok || !result.omissions.includes('point-clouds')) return null;
  let changed = false;
  const next = new Map<string, FederatedModel>();
  for (const [id, model] of models) {
    const hasInlinePointClouds = (model.geometryResult?.pointClouds?.length ?? 0) > 0;
    if (model.pointCloudHandleId === undefined && !hasInlinePointClouds) {
      next.set(id, model);
      continue;
    }
    changed = true;
    // Streamed handles are gone permanently; IFCx point data is CPU-backed,
    // so cloning its owning model invalidates ViewportContainer's merged
    // point-cloud memo and makes usePointCloudSync upload it to the replacement.
    next.set(id, { ...model, pointCloudHandleId: undefined });
  }
  return changed ? next : null;
}

export function reportDeviceRecovery(result: DeviceRecoveryResult, onRecovered: () => void): void {
  const state = useViewerStore.getState();
  const models = modelsWithoutOmittedPointCloudHandles(result, state.models);
  const pointCloudsOmitted = result.ok && result.omissions.includes('point-clouds');
  if (models || pointCloudsOmitted) {
    const legacyGeometry = pointCloudsOmitted && state.models.size === 0 && state.geometryResult?.pointClouds?.length
      ? { ...state.geometryResult, pointClouds: [...state.geometryResult.pointClouds] }
      : undefined;
    useViewerStore.setState({
      ...(models ? { models } : {}),
      ...(legacyGeometry ? { geometryResult: legacyGeometry } : {}),
      pointCloudAssetCount: 0,
      pointCloudDeviationComputed: false,
    });
  }
  // A successful replacement owns a new loss lifecycle. Re-arm the report so
  // a later replacement-device loss is visible instead of being hidden by the
  // original device's once-per-episode latch.
  if (result.ok) onRecovered();
  try {
    posthog.capture(result.ok ? 'device_loss_recovered' : 'device_loss_recovery_failed', result.ok
      ? { omissions: [...result.omissions] }
      : { reason: result.reason });
  } catch (error) {
    console.warn('[Viewport] device-loss recovery telemetry failed:', error);
  }
  void import('@/components/ui/toast').then((module) => {
    if (result.ok) {
      const detail = result.omissions.length > 0
        ? ` Some transient layers were cleared: ${result.omissions.join(', ')}.`
        : '';
      module.toast.success(`The 3D view recovered.${detail}`);
    } else {
      module.toast.error('The 3D view could not recover automatically. Reload the page to restore rendering.');
    }
  }).catch((error) => {
    console.warn('[Viewport] device-loss recovery toast unavailable:', error);
  });
}

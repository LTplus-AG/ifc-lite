/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { DeviceRecoveryResult } from '@ifc-lite/renderer';

export interface DeviceRecoverySource {
  recoverDevice(): Promise<DeviceRecoveryResult>;
}

export interface DeviceRecoveryCallbacks {
  recovered(result: Extract<DeviceRecoveryResult, { ok: true }>): void;
  failed(result: Extract<DeviceRecoveryResult, { ok: false }>): void;
}

const RETRYABLE = new Set(['device-init-failed', 'scene-restore-failed']);

export const RECOVERY_BUDGET_MAX = 3;
export const RECOVERY_BUDGET_WINDOW_MS = 60_000;

/**
 * Limits automatic recoveries across loss episodes. Each episode is bounded by
 * `startDeviceLossRecovery`, but a success re-arms the next one, so a GPU that
 * keeps failing replaces the device and re-uploads the scene without end: one
 * field session recovered 209 times in about four minutes.
 */
export function createRecoveryBudget(
  now: () => number = () => performance.now(),
): () => boolean {
  let starts: number[] = [];
  return () => {
    const at = now();
    starts = starts.filter((start) => at - start < RECOVERY_BUDGET_WINDOW_MS);
    if (starts.length >= RECOVERY_BUDGET_MAX) return false;
    starts.push(at);
    return true;
  };
}

/**
 * One immediate replacement-device attempt plus one delayed retry. The caller
 * owns cancellation; cancelling suppresses UI/telemetry callbacks but cannot
 * abort browser requestAdapter/requestDevice promises already in flight.
 */
export function startDeviceLossRecovery(
  source: DeviceRecoverySource,
  callbacks: DeviceRecoveryCallbacks,
  delay: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): { promise: Promise<DeviceRecoveryResult>; cancel(): void } {
  let cancelled = false;
  const attempt = async (): Promise<DeviceRecoveryResult> => {
    try {
      return await source.recoverDevice();
    } catch (error) {
      // Renderer.recoverDevice() normally returns typed failures. Preserve the
      // UI contract even if a custom host or an unforeseen browser path rejects.
      return { ok: false, reason: 'device-init-failed', error };
    }
  };
  const promise = (async (): Promise<DeviceRecoveryResult> => {
    let result = await attempt();
    if (!result.ok && RETRYABLE.has(result.reason)) {
      await delay(500);
      if (!cancelled) result = await attempt();
    }
    if (!cancelled) {
      if (result.ok) callbacks.recovered(result);
      else callbacks.failed(result);
    }
    return result;
  })();
  return { promise, cancel() { cancelled = true; } };
}

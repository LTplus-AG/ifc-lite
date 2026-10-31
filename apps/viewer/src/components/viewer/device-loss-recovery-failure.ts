/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { DeviceRecoveryResult } from '@ifc-lite/renderer';
import { redactFileTokens } from '@/lib/analytics-scrub.js';
import type { DeviceLossContext } from './device-loss-context.js';
import type { DeviceRecoveryAttempts } from './device-loss-recovery.js';

/**
 * Properties for `device_loss_recovery_failed` beyond its `reason`.
 *
 * `device-init-failed` used to arrive with the reason alone. That one category
 * covers a null adapter, a rejected `requestDevice()`, a replacement device
 * handed back already lost and a pipeline that failed to build, and nothing on
 * the event told them apart. In a reproduction (a forced GPU-process crash in
 * Chrome), the second loss in one document left `requestAdapter()` returning
 * null for good, while a reload got an adapter at once. These fields let field
 * events confirm or refute that.
 *
 * Keys follow the same scrubber rule as `device_lost_detail`:
 * `lib/analytics-scrub.ts` deletes any key with `message` (or `name`) as a
 * `_`-delimited word, so the text travels as `_detail` and the error class as
 * `_kind`. The scrub-path test runs the real `scrubEvent` over these keys.
 *
 * `context` is the one built when the device was lost, so `gpu_vendor` names
 * the GPU that failed even when no replacement adapter was granted.
 */
export function recoveryFailureProperties(
  result: Extract<DeviceRecoveryResult, { ok: false }>,
  attempts: DeviceRecoveryAttempts,
  context?: DeviceLossContext,
): DeviceLossContext {
  return {
    ...context,
    ...errorFields('recovery_error', result.error),
    recovery_attempts: attempts.attempts,
    recovery_episode: attempts.episode,
    recovery_elapsed_ms: attempts.elapsedMs,
    ...(attempts.first
      ? { recovery_first_reason: attempts.first.reason, ...errorFields('recovery_first_error', attempts.first.error) }
      : {}),
  };
}

/**
 * Error text is browser- or driver-supplied: bounded, never a fingerprint. The
 * scrubber only redacts whole path-like property values, so a file name inside
 * a sentence is removed here, before the text is cut.
 */
const MAX_DETAIL = 300;
const detailOf = (text: string): string => redactFileTokens(text).slice(0, MAX_DETAIL);

function errorFields(prefix: string, error: unknown): DeviceLossContext {
  if (error === undefined) return {};
  if (error instanceof Error) {
    return { [`${prefix}_kind`]: error.name.slice(0, 64), [`${prefix}_detail`]: detailOf(error.message) };
  }
  // A WebGPU `GPUError` carries `.message` but is not a JavaScript `Error`.
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') {
    return { [`${prefix}_kind`]: error.constructor.name.slice(0, 64), [`${prefix}_detail`]: detailOf(error.message) };
  }
  return { [`${prefix}_kind`]: typeof error, [`${prefix}_detail`]: detailOf(String(error)) };
}

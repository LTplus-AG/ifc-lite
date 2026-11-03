/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { resolve } from '@/i18n/registry';
import { getLocale, formatLocaleNumber } from '@/i18n';
import type { CaptureFailureCode } from '@/lib/analytics-capture-events';
import { GAUSSIAN_LAUNCH_LIMITS, type GaussianLimitBreach } from './gaussianLaunchLimits.js';

/** A capture refused before decoding: the user's translated reason and its fixed diagnostic id. */
export interface CaptureRefusal {
  message: string;
  code: CaptureFailureCode;
}

export type CaptureRefusalReason =
  | { kind: 'disabled' }
  | { kind: 'webgpu' }
  | { kind: 'limit'; breach: GaussianLimitBreach }
  | { kind: 'scene'; total: number; limit: number };

const number = (value: number) => formatLocaleNumber(getLocale(), value);
const megabytes = (bytes: number) => formatLocaleNumber(getLocale(), bytes / 1_000_000,
  { style: 'unit', unit: 'megabyte', maximumFractionDigits: 1 });

/** Resolved in the active locale at refusal time; the code never depends on it. */
export function captureRefusal(reason: CaptureRefusalReason): CaptureRefusal {
  switch (reason.kind) {
    case 'disabled': return { message: resolve('gaussianCapture.error.disabled'), code: 'gaussian_disabled' };
    case 'webgpu': return { message: resolve('gaussianCapture.error.webgpu'), code: 'gaussian_webgpu_unavailable' };
    case 'scene': return {
      message: resolve('gaussianCapture.error.sceneSplats', { total: number(reason.total), limit: number(reason.limit) }),
      code: 'gaussian_limit_scene_splats',
    };
    case 'limit': {
      const { breach } = reason;
      switch (breach.limit) {
        case 'capture-bytes': return {
          message: resolve('gaussianCapture.error.captureBytes', { size: megabytes(breach.bytes), limit: megabytes(GAUSSIAN_LAUNCH_LIMITS.maxCaptureBytes) }),
          code: 'gaussian_limit_capture_bytes',
        };
        case 'capture-splats': return {
          message: resolve('gaussianCapture.error.captureSplats', { count: number(breach.count), limit: number(GAUSSIAN_LAUNCH_LIMITS.maxSceneSplats) }),
          code: 'gaussian_limit_capture_splats',
        };
        case 'sh-degree': return {
          message: resolve('gaussianCapture.error.shDegree', { degree: breach.degree, limit: GAUSSIAN_LAUNCH_LIMITS.maxShDegree }),
          code: 'gaussian_limit_sh_degree',
        };
      }
    }
  }
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { BCFViewpoint } from '@ifc-lite/bcf';
import { toast } from '@/components/ui/toast';

export type CreateViewpointCapture =
  | { ok: true; viewpoint: BCFViewpoint }
  | { ok: false };

/**
 * Capture the viewpoint for a BCF topic that is being created (C-2). The
 * person asked for one, so a capture that throws OR resolves `null` (no
 * viewport, no camera, or a capture invalidated mid-flight — see
 * `createViewpointFromState`) is a failure: always logged, and reported only
 * while the create is still theirs (`isCurrent`, from its single-flight run),
 * since a cancelled or closed create has nothing left to report to.
 * `ok: false` means: create nothing.
 */
export async function captureViewpointForCreate(
  capture: () => Promise<BCFViewpoint | null>,
  isCurrent: () => boolean,
  failureMessage: string,
  logContext: string,
): Promise<CreateViewpointCapture> {
  let failure: unknown;
  try {
    const viewpoint = await capture();
    if (viewpoint) return { ok: true, viewpoint };
    failure = 'the capture produced no viewpoint';
  } catch (error) {
    failure = error;
  }
  console.error(`[${logContext}] failed to capture viewpoint for new topic`, failure);
  if (isCurrent()) toast.error(failureMessage);
  return { ok: false };
}

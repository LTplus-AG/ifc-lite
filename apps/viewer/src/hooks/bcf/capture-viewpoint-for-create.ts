/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { BCFViewpoint } from '@ifc-lite/bcf';
import { toast } from '@/components/ui/toast';

export type CreateViewpointCapture =
  | { ok: true; viewpoint: BCFViewpoint | null }
  | { ok: false };

/**
 * Capture the viewpoint for a BCF topic that is being created (C-2). A capture
 * that throws is always logged; the person is told only while the create is
 * still theirs (`isCurrent`, from its single-flight run), since a cancelled or
 * closed create has nothing left to report to. `ok: false` means: create nothing.
 */
export async function captureViewpointForCreate(
  capture: () => Promise<BCFViewpoint | null>,
  isCurrent: () => boolean,
  failureMessage: string,
  logContext: string,
): Promise<CreateViewpointCapture> {
  try {
    return { ok: true, viewpoint: await capture() };
  } catch (error) {
    console.error(`[${logContext}] failed to capture viewpoint for new topic`, error);
    if (isCurrent()) toast.error(failureMessage);
    return { ok: false };
  }
}

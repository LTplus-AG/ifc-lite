/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The status vocabulary's words, without the chip's icons (U02, #6925).
 *
 * Kept apart from `StatusChip` so always-loaded code that only names a status
 * (the activity tray's live-region announcement) does not pull the chip and its
 * icon set into the first-paint bundle.
 */

import type { TranslationKey } from '@/i18n';

export type ResultStatus =
  | 'complete' | 'partial' | 'failed' | 'running' | 'stale' | 'cancelled' | 'interrupted'
  | 'queued' | 'uncertain' | 'blocked' | 'unsupported'
  | 'draft' | 'ready' | 'applying' | 'applied';

const STATUS_LABEL_KEY: Record<ResultStatus, TranslationKey> = {
  complete: 'resultStatus.complete',
  partial: 'resultStatus.partial',
  failed: 'resultStatus.failed',
  running: 'resultStatus.running',
  stale: 'resultStatus.stale',
  cancelled: 'resultStatus.cancelled',
  interrupted: 'resultStatus.interrupted',
  queued: 'resultStatus.queued',
  uncertain: 'resultStatus.uncertain',
  blocked: 'resultStatus.blocked',
  unsupported: 'resultStatus.unsupported',
  draft: 'resultStatus.draft',
  ready: 'resultStatus.ready',
  applying: 'resultStatus.applying',
  applied: 'resultStatus.applied',
};

/** The word a status is shown with, for text that names it outside a chip (an announcement). */
export function statusLabelKey(status: ResultStatus): TranslationKey {
  return STATUS_LABEL_KEY[status];
}

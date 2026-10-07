/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ActivityOutcome } from '@/lib/activity/activity-journal';
import type { ResultStatus } from '../result/StatusChip';

export const JOB_STATUS: Record<ActivityOutcome, ResultStatus> = {
  running: 'running', completed: 'complete', partial: 'partial', failed: 'failed', cancelled: 'cancelled', interrupted: 'interrupted',
};

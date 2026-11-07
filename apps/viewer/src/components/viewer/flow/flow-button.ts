/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { cn } from '@/lib/utils';

/** The Flow panels' outlined button. */
export const FLOW_BUTTON = 'rounded border border-border px-2 py-0.5 hover:bg-muted disabled:opacity-50';

/** The same button for a panel's next action: Run, Approve or Resume. */
export const FLOW_PRIMARY_BUTTON = cn(FLOW_BUTTON, 'border-primary text-primary');

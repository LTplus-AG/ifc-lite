/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslatableMessage } from '@/i18n';
import type { CoordinationCard as SharedCoordinationCard } from '@ifc-lite/sdk/review';
export { buildCards, totalsForCards } from '@ifc-lite/sdk/review';
export type { CardElement, CardState, ReviewTotals } from '@ifc-lite/sdk/review';
export type CoordinationCard = SharedCoordinationCard<TranslatableMessage>;

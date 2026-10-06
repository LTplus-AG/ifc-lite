/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { EvidenceAdapter } from './types';
import { measurementsAdapter } from './measurements';
import { drawingMeasurementsAdapter } from './drawing-measurements';
import { deviationAdapter } from './deviation';

export const PACK: readonly EvidenceAdapter[] = [measurementsAdapter, drawingMeasurementsAdapter, deviationAdapter];

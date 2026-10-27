/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { RetainedClient } from './retained-client';

// M2-B skeleton: M2-C supplies requested(), StreamingGeometryEvent adaptation,
// Panel and Chip here. Constructing the client performs no work or fetches.
export const retainedKernel = { client: new RetainedClient() };

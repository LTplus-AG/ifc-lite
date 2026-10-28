/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { rmSync } from 'node:fs';

// tsc does not remove outputs orphaned by a source move. The #8042 cutover
// must also remove old TS engines from an incremental build's published dist.
rmSync(new URL('../dist/', import.meta.url), { recursive: true, force: true });

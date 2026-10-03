/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { IdentityLimits, CapturedIdentity } from './interleaved-types.js';
/** Private-shape checks refuse incomplete/unsupported outputs before this result. */
export function captureIdentity(limits: IdentityLimits): Promise<CapturedIdentity>;

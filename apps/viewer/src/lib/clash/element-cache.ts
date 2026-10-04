/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ClashElement } from '@ifc-lite/clash';

/**
 * Per-occurrence geometry of the last clash run, keyed by `[model, key]`.
 * Shared like the global clash result rather than per `useClash` instance, so
 * a run started from the Assistant leaves the Clash panel's focus able to
 * compute the real contact interface.
 */
export const clashElementCache: { current: Map<string, ClashElement> } = { current: new Map() };

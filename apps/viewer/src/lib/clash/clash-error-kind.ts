/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ClashSlice } from '@/store/slices/clashSlice';

/**
 * What kind of failure `clashError` reports, for callers that must not parse the message (#10871). Every non-null
 * `setClashError` names one, so no refusal can fall back to looking like a viewer failure:
 * - `unavailable`: the viewer cannot run it now (no geometry, every rule disabled, a model unloaded or unresolved).
 * - `unknown-target`: the run named a rule that no longer exists.
 * - `refused`: a rule's set filter cannot be run safely.
 * - `stale`: the result being acted on was superseded.
 * - `internal`: the engine failed.
 */
export type ClashErrorKind = NonNullable<ClashSlice['clashErrorKind']>;

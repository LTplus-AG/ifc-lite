/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The run-time capability gate every node calls before acting. Its own module
 * (re-exported by `host.ts`) so nodes loaded on demand, such as the AI nodes,
 * share it without pulling the rest of the host helpers along (#6923).
 */

import { CapabilityDeniedError, hasCapability, parseCapability } from '@ifc-lite/extensions';
import type { Ctx } from './host.js';

/** Throws `CapabilityDeniedError` unless the host's grants cover `raw`. */
export function requireCapability(ctx: Ctx, raw: string): void {
  if (!ctx.host.grants) return;
  const parsed = parseCapability(raw);
  if (!parsed.ok) throw new Error(`node requested a malformed capability "${raw}": ${parsed.errors.map((e) => e.message).join('; ')}`);
  if (!hasCapability(ctx.host.grants, parsed.value)) {
    throw new CapabilityDeniedError(`flow node (${raw})`, [raw], ctx.host.grants.map((g) => g.raw));
  }
}

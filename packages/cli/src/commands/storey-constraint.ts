/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { TopConstraint } from '@ifc-lite/create';

/** A CLI express id never silently rounds a fractional or unsafe number. */
export function storeyElementId(raw: string | undefined, flag: string): number {
  const text = raw?.replace(/^#/, '') ?? '';
  const id = Number(text);
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(id)) throw new Error(`${flag} must be a positive express id`);
  return id;
}

export function storeyTopConstraint(kind: string | undefined, target: string | undefined, storey: (value: string) => number): TopConstraint {
  if (kind === 'fixed' || kind === 'storeyAbove') {
    if (target !== undefined) throw new Error(`--target does not apply to --top ${kind}`);
    return { kind };
  }
  if (kind === 'storey') {
    if (target === undefined) throw new Error('--top storey needs --target <storey>');
    return { kind, storeyId: storey(target) };
  }
  if (kind === 'slab') return { kind, slabId: storeyElementId(target, '--target') };
  if (kind === 'roof') return { kind, roofId: storeyElementId(target, '--target') };
  throw new Error('--top must be fixed, storeyAbove, storey, slab or roof');
}

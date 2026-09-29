/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the Model workspace's placing commands share (charter #6232, M2):
 * typed fields bound to the defaults slice, the chain toggle, and the
 * elevation a commit writes at.
 */

import type { TranslationKey } from '@/i18n';
import { authoringDim, type AuthoredElementKind } from '@/store/slices/authoringDefaultsSlice';
import type { CommandContext, CommandField, Workplane } from '../types.js';

/**
 * A dimension field (Thickness, Height, …) that edits the defaults slice
 * rather than the gesture, so the bar, the inspector and the next element all
 * agree. `kind` may depend on the session (the Slab bar's class segment).
 */
export function defaultsField<G>(
  id: string,
  kind: AuthoredElementKind | ((ctx: CommandContext) => AuthoredElementKind),
  name: string,
  labelKey: TranslationKey,
  group = 'dims',
): CommandField<G> {
  const kindOf = typeof kind === 'function' ? kind : () => kind;
  return {
    id,
    labelKey,
    unit: 'm',
    group,
    read: (_g, ctx) => authoringDim(ctx.get().authoringDefaults, kindOf(ctx), name),
    write: (g, v, ctx) => {
      // A section must stay positive; an offset (Bottom at) may be anything.
      if (name !== 'Bottom' && !(v > 0)) return g;
      ctx.get().setAuthoringDims(kindOf(ctx), { [name]: v });
      return g;
    },
  };
}

/** A dimension of `kind` as the next commit will build it. */
export function dimOf(ctx: Pick<CommandContext, 'get'>, kind: AuthoredElementKind, name: string): number {
  return authoringDim(ctx.get().authoringDefaults, kind, name);
}

/**
 * Storey-local z of the workplane: builders take storey-local coordinates,
 * and a storey plane may be raised off the floor by its offset.
 */
export function planeZ(plane: Workplane | null): number {
  return plane?.spec.kind === 'storey' ? plane.spec.offset : 0;
}

/** Chain off: a fresh gesture after each commit. */
export const chainOn = (ctx: Pick<CommandContext, 'get'>): boolean => ctx.get().authoringDefaults.chain;

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `element.paste` (#6232 C3): Ctrl+V in the Model workspace. The copied
 * elements follow the cursor (snapped), gripped at the first one's placement
 * origin, and a click writes them there on the workspace's storey: switch
 * storey first to paste onto another one, where they keep their height above
 * the floor. Ctrl+Shift+V pastes in place, at the same plan position. One
 * paste is one undo step; the copies are selected.
 */

import type { CopyTransform } from '@ifc-lite/create';
import type { TranslationKey } from '@/i18n';
import { resolve as translate } from '@/i18n/registry';
import type { Vec2 } from '@/lib/snap/types';
import { useViewerStore } from '@/store';
import { copyElements, copySources, withHostedFillings } from '../copy-elements.js';
import { readCopyClipboard, type CopyClipboard } from '../copy-clipboard.js';
import { copyGhosts, sourceMeshes } from '../copy-ghost.js';
import type { CommandContext, ModelingCommand, Workplane } from '../types.js';
import { buildStoreyWorkplane, elementStoreyId, isWorkplane } from '../workplane.js';

export interface PasteGesture {
  readonly clip: CopyClipboard | null;
  readonly refusal: TranslationKey | null;
  readonly cursor: Vec2 | null;
  /** Paste at the copied plan position instead of the cursor (Ctrl+Shift+V). */
  readonly inPlace: boolean;
  /** The copied elements and the doors and windows that come with them: the preview. */
  readonly shown: readonly number[];
}

function init(ctx: CommandContext): PasteGesture {
  const clip = readCopyClipboard();
  // The elements are read again: one moved or deleted since Ctrl+C may no longer be copyable, and the preview must say so.
  const refusal: TranslationKey | null = !clip ? 'copyArray.paste.empty'
    : clip.modelId !== ctx.modelId ? 'copyArray.paste.otherModel'
      : 'refusal' in copySources(ctx.get(), clip.modelId, clip.ids) ? 'copyArray.paste.stale' : null;
  return {
    clip: refusal ? null : clip, refusal, cursor: null, inPlace: false,
    shown: clip && !refusal ? withHostedFillings(ctx.get(), ctx.modelId, clip.ids) : [],
  };
}

/** The move from the copied elements to where this paste puts them, on `storeyId`. */
export function pasteTransform(g: PasteGesture, storeyId: number): CopyTransform | null {
  if (!g.clip) return null;
  if (g.inPlace) return { targetStoreyId: storeyId };
  if (!g.cursor) return null;
  const [bx, by] = g.clip.base;
  return { offset: [g.cursor[0] - bx, g.cursor[1] - by, 0], targetStoreyId: storeyId };
}

function storeyPlane(ctx: CommandContext, storeyId: number | null): Workplane | null {
  if (storeyId === null) return null;
  const plane = buildStoreyWorkplane(ctx.get(), ctx.modelId, storeyId, 0);
  return isWorkplane(plane) ? plane : null;
}

export const ELEMENT_PASTE: ModelingCommand<PasteGesture> = {
  id: 'element.paste',
  labelKey: 'copyArray.paste.label',
  hud: { hint: (g) => g.refusal ?? 'copyArray.paste.hint' },
  snap: 'modeling',
  init,
  snapQuery: () => ({ anchor: null, chain: [], locks: {} }),
  pointerMove: (g, s) => ({ ...g, cursor: s.local }),
  pointerDown: (g) => (g.clip ? { commit: true } : g),
  doubleClick: (g) => g,
  validate(g, ctx) {
    if (g.refusal) return { ok: false, reasonKey: g.refusal };
    if (ctx.storeyId === null || !ctx.workplane) return { ok: false, reasonKey: 'modelingCommand.noPlane' };
    return g.inPlace || g.cursor ? { ok: true } : { ok: false, reasonKey: 'copyArray.paste.hint' };
  },
  commit(g, tx) {
    const transform = tx.storeyId === null ? null : pasteTransform(g, tx.storeyId);
    if (!g.clip || !transform) throw new Error(translate('copyArray.paste.empty'));
    const { copies, meshed } = copyElements(useViewerStore, tx.modelId, g.clip.ids, [transform]);
    return { created: [...copies], deleted: [], remesh: [...meshed], select: [...copies] };
  },
  afterCommit: () => ({ exit: true }),
  ghost(g, ctx) {
    const transform = ctx.storeyId === null ? null : pasteTransform(g, ctx.storeyId);
    if (!g.clip || !transform) return [];
    const s = ctx.get();
    const from = storeyPlane(ctx, elementStoreyId(s, ctx.modelId, g.clip.ids[0]));
    const to = storeyPlane(ctx, ctx.storeyId);
    if (!from || !to) return [];
    return copyGhosts(s, sourceMeshes(s, ctx.modelId, g.shown), from, to, [transform]);
  },
};

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Who owns the colour-override channel while a validation report (IDS or
 * Information validation) is painted red/green — and the one way to hand it
 * back (#6373).
 *
 * The report colours are an OVERLAY in `pendingColorUpdates`, the same channel
 * the lens, clash and SDK `colorize()` write; the model's own colours are never
 * touched. "Restore original colours" is therefore "stop painting": hand the
 * channel back to its base, which is the active lens's colouring
 * (`lensAppliedColors`) or, with no lens, an empty map (the renderer's "clear
 * every override" signal). That is the same restore `showAllFromStore` and the
 * clash teardowns use.
 *
 * Before #6373 the validation results had no such control — the only colour
 * button re-sent the report colours ("Reapply Colors") — and clearing or
 * replacing a report left its red/green painted on a model whose results were
 * gone.
 *
 * ## Why a revision, not a map comparison
 *
 * `pendingColorUpdates` is a one-shot SIGNAL the renderer nulls after flushing
 * it, so the painted map cannot be read back. `colorPresentationRevision`
 * (dataSlice) is the durable record: every write to the channel bumps it. IDS
 * records the revision its own last write produced; while the live revision
 * still equals it, nobody has painted since, and the report colours are what
 * is on screen. Once anyone else writes (a lens, a clash focus, a script, the
 * ribbon's Reset Colors), the claim lapses and a report clear leaves their
 * colours alone — the same test `lib/clash/group-focus.ts` uses.
 */

type RGBA = [number, number, number, number];
type ColorMap = Map<number, RGBA>;

/** The store surface these helpers read and write. Optional members for the
 *  same reason as `IDSFocusVisibilityChannels`: slice-level harnesses stub
 *  `get()` with a single slice. */
export interface IdsColorPresentation {
  colorPresentationRevision?: number;
  lensAppliedColors?: ColorMap | null;
  idsColorRevision?: number | null;
  idsColorsShown?: boolean;
  setPendingColorUpdates?: (updates: ColorMap) => void;
  setIdsColorRevision?: (revision: number | null) => void;
}

/** What the channel shows when validation paints nothing: the lens, or no overrides. */
function baseColors(state: IdsColorPresentation): ColorMap {
  return new Map(state.lensAppliedColors ?? []);
}

/**
 * Paint `colors` as the validation overlay and claim the channel. An empty map
 * paints the base (original colours, or the lens's), which is what a hidden
 * report or a report with nothing to colour must show.
 */
export function paintIdsColors(getState: () => IdsColorPresentation, colors: ColorMap): void {
  const state = getState();
  state.setPendingColorUpdates?.(colors.size > 0 ? colors : baseColors(state));
  const after = getState();
  after.setIdsColorRevision?.(after.colorPresentationRevision ?? null);
}

/** Whether the report colours are what is on screen right now. */
export function idsColorsOnScreen(state: IdsColorPresentation): boolean {
  return state.idsColorsShown !== false
    && state.idsColorRevision != null
    && state.idsColorRevision === state.colorPresentationRevision;
}

/**
 * End the validation colour overlay because its report is going away (cleared,
 * replaced, its document unloaded or its model removed): restore the base
 * colours if IDS is still the last painter, and drop the claim either way.
 *
 * @returns whether the channel was actually handed back.
 */
export function endIdsColorPresentation(state: IdsColorPresentation): boolean {
  if (state.idsColorRevision == null) return false;
  const ours = state.idsColorRevision === state.colorPresentationRevision;
  if (ours) state.setPendingColorUpdates?.(baseColors(state));
  state.setIdsColorRevision?.(null);
  return ours;
}

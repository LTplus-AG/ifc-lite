/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The save half of `useDrawing2DPersistence.ts`'s #4153 bridge (see that
 * module's doc for the bridge's overall shape): a raw store subscription
 * that persists the five markup fields to `localStorage` (via
 * `drawing2DSlice.persistence.ts`) on every change, keyed by the active
 * model's already-resolved content hash. Split out of
 * `useDrawing2DPersistence.ts` into its own module (module-size budget) —
 * that hook's restore effect calls back into {@link beginRestore},
 * {@link endRestore}, {@link setRestoredSectionConfig} and
 * {@link resetSaveState} below to keep this module's own bookkeeping (which
 * model is mid-restore, and its most recent `SectionConfig`) in sync with
 * the restore effect, rather than reaching into this module's mutable
 * module-level state directly.
 *
 * ## Why the save path derives the hash SYNCHRONOUSLY from `hashCache`
 * rather than from a variable the restore effect maintains
 * A primary reload calls `resetViewerState()`, then `clearAllModels()`,
 * which together wipe `measure2DResults` etc. to `[]` and `activeModelId` to
 * `null` — BEFORE the next model has loaded or its hash resolved. The
 * store's raw `subscribe` listener fires synchronously inside those `set()`
 * calls — synchronously with respect to the reset, not the (async,
 * React-effect-driven) hash resolution for whatever model loads next. If the
 * save path read its scoping key from a variable the restore effect owns, it
 * would still be pointing at the OLD model's hash at that instant and would
 * persist the wipe — overwriting the old model's saved markup with an empty
 * entry. Deriving the hash from `state.activeModelId` instead makes the skip
 * automatic and correct: no hash, no save.
 *
 * That guard only WORKS because `modelSlice.teardown.ts`'s 'session-reset'
 * contribution nulls `activeModelId` in the SAME atomic patch that wipes the
 * markup fields (#4159 fix — it used to be `notApplicable`, leaving
 * `activeModelId` pointing at the OUTGOING model through that patch, so this
 * exact subscription read a "still-active" model whose markup had just been
 * wiped and persisted the wipe over its saved entry). This module has no way
 * to enforce that from the outside; it can only document the dependency.
 * `modelSlice.teardown.ts`'s own comment explains why nulling it there is
 * safe — every production call site pairs `resetViewerState()` with an
 * immediate `clearAllModels()` that already nulls it a moment later.
 *
 * ## Cross-model leak on an ordinary model switch (#4159 Bug 2)
 * `measure2DResults` and friends are flat, federation-wide store fields, not
 * scoped per model. Left alone, switching from model A to model B via
 * `setActiveModel()` leaves A's markup sitting in the store as B becomes
 * active: readable on B's canvas, and — since the save subscription below
 * keys purely off `activeModelId` — persistable into B's saved entry by any
 * change at all (drawing something, or `notifyDrawing2DSectionConfig` firing
 * from a 2D redraw) before B's own hash has even resolved.
 *
 * The PRIMARY fix is in `modelSlice.ts`'s `setActiveModel`: it now clears the
 * five persisted fields to `defaultMarkupPatch` in the SAME atomic `set()`
 * call that moves `activeModelId`, so no subscriber — this module's save
 * listener included — can ever observe "B is active" together with "the
 * fields still hold A's data". That is what closes the window completely;
 * doing it in `useDrawing2DPersistence.ts`'s restore effect would only
 * narrow it (React effects run after the store has already committed and
 * after any other subscriber's synchronous reaction to the same change). The
 * clear that effect ALSO performs, before resolving B's hash, is a redundant
 * second layer — it protects state seeded directly via
 * `useViewerStore.setState()` (tests, or any future caller that bypasses the
 * `setActiveModel` action) rather than being the thing that makes the fix
 * correct.
 *
 * ## The atomic clear's own leak: A → B → A destroys A's saved entry (#4159 Bug 4)
 * Closing Bug 2 by clearing the fields atomically WITH the id change created
 * a new failure: the save subscription below cannot tell "the fields were
 * just cleared because a switch is in progress" apart from "the user
 * genuinely cleared this model's markup" — both are "new id, default
 * fields" to a listener that only ever sees committed state. Switching A → B
 * → A when BOTH hashes are already cached (both models visited earlier this
 * session) hits it: the A → B leg clears to defaults and (no hash cached
 * for B yet, or B not yet visited — usually a no-op) is harmless; the B → A
 * leg ALSO clears to defaults, but `hash(A)` IS cached, so this listener
 * fires with "A active, fields = defaults" and synchronously overwrites A's
 * real saved entry with an empty one — before the restore effect has
 * restored anything. The restore effect then reads back exactly what this
 * listener just destroyed.
 *
 * Fixed by having `setActiveModel` mark its own accompanying clear via
 * `suppressNextSaveFor(modelId)`, in the SAME atomic patch, and this
 * listener consuming that mark instead of persisting. The mark is consumed
 * (not merely checked), so it covers only that one notification — a real
 * change to the same model right after still saves normally — and it is
 * keyed by model id, not a single flag, so an A → B switch cannot consume
 * the mark meant for a later B → A switch.
 */

import type { SectionConfig } from '@ifc-lite/drawing-2d';
import { useViewerStore } from '@/store';
import {
  saveDrawing2DEntry,
  consumeSuppressedSave,
} from '@/store/slices/drawing2DSlice.persistence.js';
import { getCachedHash } from './drawingMarkupRestorePrecedence.js';

/**
 * The `SectionConfig` that produced the drawing currently on screen, if any.
 * Not store state — `drawing2D`/its inputs are deliberately not reactive
 * fields consumers subscribe to here, only a value this module remembers so
 * it can be folded into the next save. Reset alongside the rest of the
 * markup by `useDrawing2DPersistence.ts`'s restore effect, via the exported
 * functions below.
 */
let lastSectionConfig: SectionConfig | null = null;

/** The model whose hash `lastSectionConfig` belongs to, so a stale config from a just-replaced model never leaks into the next model's save. */
let lastSectionConfigModelId: string | null = null;

/**
 * Set (to the restoring model's id) the instant {@link setRestoredSectionConfig}
 * is called with an entry that actually carries a `sectionConfig` (issue
 * #4153 gap: restore reached `lastSectionConfig` but was never fed to drawing
 * generation, so the saved markup came back with no section cut to sit on).
 * Consumed exactly once by {@link consumeRestoredSectionConfig} —
 * `useDrawingGeneration.ts` reads it to re-derive the store's `sectionPlane`
 * (percentage-of-bounds, semantic axis) from this module's world-space
 * `SectionConfig`, then lets the existing plane-changed auto-generate path do
 * the rest. Reset to `null` everywhere `lastSectionConfig` itself is reset,
 * so a model with nothing saved (or whose restore has not concluded yet) can
 * never be "consumed" as if it had.
 */
let pendingSectionConfigModelId: string | null = null;

/**
 * Hand the generation bridge (`useDrawingGeneration.ts`) the `SectionConfig`
 * this module just restored for `modelId`, if any — one-shot: a second call
 * for the same restore returns `null`, so a plane the user has since changed
 * is never silently re-applied. Returns `null` for a model whose restore has
 * not (yet) surfaced a saved plane, or for any model other than the one the
 * pending config belongs to — the same per-model keying `restoringModelId`
 * uses, so a caller cannot cross-apply model A's cut to model B by racing
 * this against a switch.
 */
export function consumeRestoredSectionConfig(modelId: string): SectionConfig | null {
  if (pendingSectionConfigModelId !== modelId) return null;
  pendingSectionConfigModelId = null;
  return lastSectionConfigModelId === modelId ? lastSectionConfig : null;
}

/**
 * Set the instant `useDrawing2DPersistence.ts`'s restore effect starts
 * working on a model, and cleared once its `applyHash` step concludes for
 * that SAME model (#4159 review: cross-model `sectionConfig` contamination).
 * `setActiveModel`'s `liveMarkupCache` (`drawing2DSlice.markupTransition.ts`)
 * restores the five flat markup ARRAYS synchronously, in the same atomic
 * patch that moves `activeModelId` — but it deliberately does not carry
 * `sectionConfig` (see its own doc), which stays owned by
 * `lastSectionConfig`/`lastSectionConfigModelId` here, reset only via the
 * restore effect's own calls below. That effect runs on a separate, later
 * scheduled task from the atomic patch, so a `notifyDrawing2DSectionConfig`
 * call landing in that gap — a generation that started for the OUTGOING
 * model and only reads `activeModelId` fresh when it finally resolves —
 * would otherwise pass the `modelId` check below and write the outgoing
 * model's plane into the new model's saved entry. `restoringModelId` closes
 * that: `notifyDrawing2DSectionConfig` refuses to persist for `modelId`
 * while its own restore is still in flight.
 */
let restoringModelId: string | null = null;

/** Reset all save-path bookkeeping — call when no model is active at all. */
export function resetSaveState(): void {
  lastSectionConfig = null;
  lastSectionConfigModelId = null;
  pendingSectionConfigModelId = null;
  restoringModelId = null;
}

/** Mark `modelId`'s restore as starting: its stale `sectionConfig` is cleared and saves for it are held off until {@link endRestore}. */
export function beginRestore(modelId: string): void {
  lastSectionConfig = null;
  lastSectionConfigModelId = null;
  pendingSectionConfigModelId = null;
  restoringModelId = modelId;
}

/** Mark `modelId`'s restore as concluded (whether or not a saved entry was found) and clear any stale `sectionConfig`. */
export function endRestore(modelId: string): void {
  lastSectionConfig = null;
  lastSectionConfigModelId = null;
  pendingSectionConfigModelId = null;
  if (restoringModelId === modelId) restoringModelId = null;
}

/**
 * Record the `SectionConfig` a just-concluded restore found for `modelId`, so
 * it is folded into that model's next save. Also marks it "pending" for
 * {@link consumeRestoredSectionConfig} — but only when there IS a config to
 * apply (#4153 gap): an entry with markup but no saved cut (`sectionConfig:
 * null`, e.g. saved before this fix shipped) must leave the section plane
 * alone rather than have `useDrawingGeneration.ts` try to consume `null`.
 */
export function setRestoredSectionConfig(modelId: string, config: SectionConfig | null): void {
  lastSectionConfig = config;
  lastSectionConfigModelId = modelId;
  if (config) pendingSectionConfigModelId = modelId;
}

function currentHashFor(modelId: string | null): string | null | undefined {
  if (!modelId) return undefined;
  return getCachedHash(modelId);
}

function persistFor(modelId: string): void {
  const hash = currentHashFor(modelId);
  if (!hash) return;
  const s = useViewerStore.getState();
  saveDrawing2DEntry(hash, {
    measure2DResults: s.measure2DResults,
    polygonArea2DResults: s.polygonArea2DResults,
    textAnnotations2D: s.textAnnotations2D,
    cloudAnnotations2D: s.cloudAnnotations2D,
    drawing2DDisplayOptions: s.drawing2DDisplayOptions,
    sectionConfig: lastSectionConfigModelId === modelId ? lastSectionConfig : null,
  });
}

/**
 * Call after a 2D drawing is (re)generated so its `SectionConfig` is folded
 * into the next save for the CURRENTLY active model. A no-op call from a
 * generation that finished after the model changed (`modelId` stale) is
 * ignored rather than misattributed; a call for a model whose restore effect
 * has not yet run is ALSO ignored — see {@link restoringModelId} — rather
 * than risk persisting a config computed for a different model.
 */
export function notifyDrawing2DSectionConfig(modelId: string, config: SectionConfig | null): void {
  if (useViewerStore.getState().activeModelId !== modelId) return;
  if (restoringModelId === modelId) return;
  lastSectionConfig = config;
  lastSectionConfigModelId = modelId;
  persistFor(modelId);
}

/** Registers the raw store subscription that saves on every persisted-field change. Idempotent — module-level, subscribed once regardless of how many components mount `useDrawing2DPersistence`. */
let saveSubscriptionStarted = false;
export function ensureSaveSubscription(): void {
  if (saveSubscriptionStarted) return;
  saveSubscriptionStarted = true;
  let prev = useViewerStore.getState();
  useViewerStore.subscribe((state) => {
    const modelId = state.activeModelId;
    // #4159 review (cross-model sectionConfig contamination): mark
    // `restoringModelId` the INSTANT `activeModelId` moves — synchronously,
    // inside this `set()`-driven subscription callback — not inside the
    // restore effect. The effect is a React-scheduled passive effect, a
    // separate (later) task from whatever synchronous `set()` call moved
    // `activeModelId` (`setActiveModel`, `addModel`, `upsertModel`, a raw
    // `setState`…); setting the mark only inside the effect would leave that
    // whole gap unguarded — a stray `notifyDrawing2DSectionConfig` call
    // landing there would see `restoringModelId` still pointing at (or past)
    // the PREVIOUS model and persist unchecked. Subscribing here instead
    // means the mark is live before any other code can observe the new
    // `activeModelId` at all.
    if (modelId !== prev.activeModelId) restoringModelId = modelId;
    const changed =
      state.measure2DResults !== prev.measure2DResults ||
      state.polygonArea2DResults !== prev.polygonArea2DResults ||
      state.textAnnotations2D !== prev.textAnnotations2D ||
      state.cloudAnnotations2D !== prev.cloudAnnotations2D ||
      state.drawing2DDisplayOptions !== prev.drawing2DDisplayOptions;
    prev = state;
    if (!changed || !modelId) return;
    // #4159 Bug 4: `setActiveModel`'s atomic patch clears these fields to
    // defaults in the SAME `set()` that moves `activeModelId` — this
    // listener fires synchronously inside that call, before the restore
    // effect has run, and cannot otherwise tell that accompanying clear
    // apart from the user genuinely clearing the new model's own markup.
    // `suppressNextSaveFor` marks exactly that one notification; consuming
    // it here (rather than checking-without-consuming) means any later,
    // real change to the same model still saves normally. Always consumed,
    // even when the `restoringModelId` check below is what actually skips
    // this notification — an unconsumed mark would otherwise wrongly
    // swallow the NEXT, genuinely real, change to this same model.
    const suppressed = consumeSuppressedSave(modelId);
    // #4159 review (cross-model sectionConfig contamination): also skip
    // while `modelId`'s restore is in flight, independent of the suppress
    // mark above. `drawing2DSlice.markupTransition.ts`'s `liveMarkupCache`
    // restores a REVISITED model's five markup fields synchronously in
    // `setActiveModel`'s own atomic patch — a real reference change this
    // listener sees as "changed" — but does NOT mark it suppressed (it is
    // not the "genuinely new to this session" case `suppressNextSaveFor`
    // covers) and does NOT touch `sectionConfig`. Persisting right here,
    // before the restore effect has re-associated `lastSectionConfig` with
    // `modelId`, would write `sectionConfig: null` over the model's real
    // saved plane on every single revisit.
    if (restoringModelId === modelId) return;
    if (suppressed) return;
    persistFor(modelId);
  });
}

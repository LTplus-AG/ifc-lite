/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tour engine controller - a plain module singleton (same pattern as
 * `getViewerStoreApi`), so entry points that live outside React (command
 * palette actions, window events) can drive it directly.
 *
 * Step lifecycle: arm baselines -> prepare() -> entry-time gate evaluation
 * (an already satisfied step advances silently) -> anchor resolution ->
 * active (gate subscription + hint timer). prepare runs BEFORE the entry
 * evaluation on purpose: steps like "select an element" clear stale state
 * in prepare precisely so it cannot auto-complete the step. Steps never
 * trap: gates have no timeout-skip, but Skip is always available, a broken
 * anchor auto-skips with telemetry, and a throwing predicate degrades the
 * step to passive.
 *
 * Aborts are X-on-card only, plus two automatic destructive signals: the
 * viewport flipping to mobile (the whole desktop layout - and every anchor -
 * unmounts) and a model the tour was running against disappearing outside a
 * step that expects a load. There is deliberately NO Esc abort:
 * useKeyboardShortcuts owns Escape (clear selection / double-Esc close all)
 * and preventDefaults every press.
 */

import { getViewerStoreApi } from '@/store';
import type { ViewerState } from '@/store';
import { resolveAnchor } from './anchor-resolver';
import { loadDemoProject, waitForModelSettled } from './demo-kit';
import { getTour } from './registry';
import { captureUiSnapshot, restoreUiSnapshot } from './snapshot';
import * as storage from './storage';
import * as telemetry from './telemetry';
import { patchTourState, resetTourState, useTourStore } from './tour-store';
import type {
  TourAbortReason,
  TourDefinition,
  TourId,
  TourSource,
  TourStep,
  TourStepContext,
  UiSnapshot,
} from './types';

interface RunRecord {
  def: TourDefinition;
  source: TourSource;
  startedAt: number;
  stepStartedAt: number;
  snapshot: UiSnapshot;
  /** Context of the ACTIVE step (fresh per step). */
  ctx: TourStepContext;
  executed: Array<{ step: TourStep; ctx: TourStepContext }>;
  skipped: number;
  anySkipped: boolean;
  /** Monotonic step token: guards async work against superseded steps. */
  token: number;
  teardownStep: (() => void) | null;
  teardownRun: (() => void) | null;
}

let run: RunRecord | null = null;
let prereqPending: { def: TourDefinition; source: TourSource } | null = null;

function prereqsMet(def: TourDefinition, s: ViewerState): boolean {
  const p = def.prerequisites;
  if (!p) return true;
  if (p.modelLoaded && !(s.models.size > 0 && !s.loading && !s.geometryStreamingActive)) return false;
  if (p.secondModel && [...s.models.values()].filter((m) => m.ifcDataStore).length < 2) return false;
  return true;
}

export function startTour(id: TourId, source: TourSource): void {
  const store = getViewerStoreApi();
  if (run || useTourStore.getState().status !== 'idle') return;
  if (store.getState().isMobile) return;
  const def = getTour(id);
  if (!def) return;
  if (!prereqsMet(def, store.getState())) {
    prereqPending = { def, source };
    patchTourState({ status: 'prereq', tourId: id, source });
    return;
  }
  beginRun(def, source);
}

/** "Load demo project" on the prerequisite interstitial. */
export async function confirmPrereqWithDemo(): Promise<void> {
  const pending = prereqPending;
  if (!pending) return;
  patchTourState({ demoLoading: true });
  try {
    await (pending.def.demoFulfil ?? loadDemoProject)();
    telemetry.trackDemoLoaded(pending.def.id);
    await waitForModelSettled();
  } catch (err) {
    console.warn('[tours] demo load failed:', err);
    if (prereqPending === pending) patchTourState({ demoLoading: false });
    return;
  }
  if (prereqPending !== pending) return; // cancelled meanwhile
  prereqPending = null;
  patchTourState({ demoLoading: false });
  beginRun(pending.def, pending.source);
}

export function cancelPrereq(): void {
  prereqPending = null;
  resetTourState();
}

function beginRun(def: TourDefinition, source: TourSource): void {
  const store = getViewerStoreApi();
  const r: RunRecord = {
    def,
    source,
    startedAt: performance.now(),
    stepStartedAt: performance.now(),
    snapshot: captureUiSnapshot(store),
    ctx: { baseline: {}, artifacts: new Map() },
    executed: [],
    skipped: 0,
    anySkipped: false,
    token: 0,
    teardownStep: null,
    teardownRun: null,
  };
  run = r;
  telemetry.trackTourStarted(def.id, source);
  patchTourState({
    status: 'running',
    tourId: def.id,
    source,
    stepIndex: 0,
    stepPhase: 'preparing',
    targetEl: null,
    hintVisible: false,
    gateBroken: false,
    redockedPanel: false,
    demoLoading: false,
  });
  installRunWatchers(r);
  void goToStep(r, 0);
}

function installRunWatchers(r: RunRecord): void {
  const store = getViewerStoreApi();
  let knownIds = new Set(store.getState().models.keys());
  const unsub = store.subscribe((state) => {
    if (run !== r) return;
    if (state.isMobile) {
      abortTour('mobile-flip');
      return;
    }
    for (const id of knownIds) {
      if (!state.models.has(id)) {
        const step = r.def.steps[useTourStore.getState().stepIndex];
        if (step?.expectsModelLoad) {
          // Expected replacement (file open / demo load) - rebaseline.
          knownIds = new Set(state.models.keys());
          return;
        }
        abortTour('model-change');
        return;
      }
    }
    if (state.models.size !== knownIds.size) knownIds = new Set(state.models.keys());
  });
  r.teardownRun = unsub;
}

async function goToStep(r: RunRecord, index: number): Promise<void> {
  if (run !== r) return;
  r.teardownStep?.();
  r.teardownStep = null;
  if (index >= r.def.steps.length) {
    finishTour(r);
    return;
  }
  const store = getViewerStoreApi();
  const step = r.def.steps[index];
  const ctx: TourStepContext = { baseline: {}, artifacts: new Map() };
  r.ctx = ctx;
  r.stepStartedAt = performance.now();
  const token = ++r.token;
  const isCurrent = () => run === r && r.token === token;
  patchTourState({
    stepIndex: index,
    stepPhase: 'preparing',
    targetEl: null,
    hintVisible: false,
    gateBroken: false,
    redockedPanel: false,
  });

  // Arm baselines, run prepare, THEN evaluate the gate at entry: an already
  // satisfied action step advances silently instead of flashing a stale
  // instruction. prepare must come before the entry evaluation - it is where
  // steps clear stale state (a lingering selection, a leftover tab) exactly
  // so that state cannot auto-complete the step.
  try {
    step.arm?.(store.getState(), ctx);
  } catch (err) {
    console.warn('[tours] step arm failed:', err);
  }
  try {
    await step.prepare?.(store);
  } catch (err) {
    console.warn('[tours] step prepare failed:', err);
  }
  if (!isCurrent()) return;
  try {
    if (step.gate?.predicate?.(store.getState(), ctx)) {
      r.executed.push({ step, ctx });
      telemetry.trackStepCompleted(r.def.id, step.id, index, true, 0);
      void goToStep(r, index + 1);
      return;
    }
  } catch (err) {
    // Fall through - the subscription path reports repeat predicate errors.
    console.warn('[tours] entry gate evaluation failed:', err);
  }

  if (step.kind !== 'canvas') {
    patchTourState({ stepPhase: 'anchoring' });
    const res = await resolveAnchor(store, step, isCurrent);
    if (!isCurrent()) return;
    if (!res.el) {
      const reason = res.reason ?? 'anchor-missing';
      telemetry.trackStepBroken(
        r.def.id,
        step.id,
        index,
        step.anchor,
        // A missing anchor after the user skipped an earlier step is usually
        // an unmet in-tour prerequisite, not rot - report it separately.
        r.anySkipped && reason === 'anchor-missing' ? 'prerequisite-not-met' : reason,
      );
      void goToStep(r, index + 1);
      return;
    }
    patchTourState({ targetEl: res.el, redockedPanel: res.redocked });
  }
  patchTourState({ stepPhase: 'active' });

  if (step.gate) {
    const cleanups: Array<() => void> = [];
    let fired = false;
    const fire = () => {
      if (fired || !isCurrent()) return;
      fired = true;
      for (const fn of cleanups) fn();
      // Settle delay: let the UI the action produced (panel opening, zoom)
      // land before the spotlight moves on.
      window.setTimeout(() => {
        if (isCurrent()) completeStep(r, step, index, true);
      }, 300);
    };
    if (step.gate.predicate) {
      const predicate = step.gate.predicate;
      let last = false;
      const unsub = store.subscribe((state) => {
        let next = false;
        try {
          next = predicate(state, ctx);
        } catch (err) {
          // Degrade to a passive Next step instead of trapping the user.
          console.warn('[tours] step gate predicate threw:', err);
          unsub();
          telemetry.trackStepBroken(r.def.id, step.id, index, step.anchor, 'predicate-error');
          if (isCurrent()) patchTourState({ gateBroken: true });
          return;
        }
        if (next && !last) fire();
        last = next;
      });
      cleanups.push(unsub);
    }
    if (step.gate.event) {
      const evt = step.gate.event;
      const wantedKind = step.gate.eventKind;
      const onEvent = (e: Event) => {
        if (wantedKind !== undefined) {
          const kind = (e as CustomEvent<{ kind?: string } | undefined>).detail?.kind;
          if (kind !== wantedKind) return;
        }
        fire();
      };
      window.addEventListener(evt, onEvent);
      cleanups.push(() => window.removeEventListener(evt, onEvent));
    }
    const hintTimer = window.setTimeout(() => {
      if (isCurrent()) patchTourState({ hintVisible: true });
    }, step.gate.hintAfterMs ?? 15_000);
    cleanups.push(() => window.clearTimeout(hintTimer));
    r.teardownStep = () => {
      for (const fn of cleanups) fn();
    };
  }
}

function completeStep(r: RunRecord, step: TourStep, index: number, gated: boolean): void {
  if (run !== r || useTourStore.getState().stepIndex !== index) return;
  r.teardownStep?.();
  r.teardownStep = null;
  r.executed.push({ step, ctx: r.ctx });
  telemetry.trackStepCompleted(r.def.id, step.id, index, gated, performance.now() - r.stepStartedAt);
  void goToStep(r, index + 1);
}

/** Next on a passive (or gate-broken) step. */
export function nextStep(): void {
  const r = run;
  if (!r) return;
  const index = useTourStore.getState().stepIndex;
  const step = r.def.steps[index];
  if (!step) return;
  completeStep(r, step, index, false);
}

export function skipStep(): void {
  const r = run;
  if (!r) return;
  const index = useTourStore.getState().stepIndex;
  const step = r.def.steps[index];
  if (!step) return;
  r.teardownStep?.();
  r.teardownStep = null;
  telemetry.trackStepSkipped(r.def.id, step.id, index, useTourStore.getState().hintVisible);
  r.skipped += 1;
  r.anySkipped = true;
  void goToStep(r, index + 1);
}

/** The active step's card action (e.g. "Load demo project"). */
export async function runStepAction(): Promise<void> {
  const r = run;
  if (!r) return;
  const index = useTourStore.getState().stepIndex;
  const step = r.def.steps[index];
  if (!step?.action) return;
  patchTourState({ demoLoading: true });
  try {
    await step.action.run(getViewerStoreApi());
    if (step.expectsModelLoad) telemetry.trackDemoLoaded(r.def.id);
  } catch (err) {
    console.warn('[tours] step action failed:', err);
  } finally {
    if (run === r) patchTourState({ demoLoading: false });
  }
}

function runCleanups(r: RunRecord): void {
  const store = getViewerStoreApi();
  const index = useTourStore.getState().stepIndex;
  const current = r.def.steps[index];
  // On a normal finish the final step was already pushed to `executed`
  // before the index advanced past the end - running it again here as
  // "current" would double-fire its cleanup.
  if (current?.cleanup && !r.executed.some((e) => e.step === current)) {
    try {
      current.cleanup(store, r.ctx);
    } catch (err) {
      console.warn('[tours] step cleanup failed:', err);
    }
  }
  for (let i = r.executed.length - 1; i >= 0; i--) {
    const { step, ctx } = r.executed[i];
    try {
      step.cleanup?.(store, ctx);
    } catch (err) {
      console.warn('[tours] step cleanup failed:', err);
    }
  }
}

function finishTour(r: RunRecord): void {
  if (run !== r) return;
  run = null;
  r.teardownStep?.();
  r.teardownRun?.();
  runCleanups(r);
  try {
    restoreUiSnapshot(getViewerStoreApi(), r.snapshot, r.def.keepOnFinish ?? []);
  } catch (err) {
    console.warn('[tours] snapshot restore failed:', err);
  }
  storage.markTourCompleted(r.def.id, r.def.version);
  telemetry.trackTourCompleted(r.def.id, performance.now() - r.startedAt, r.skipped);
  resetTourState();
}

export function abortTour(reason: TourAbortReason = 'close'): void {
  if (!run && prereqPending) {
    cancelPrereq();
    return;
  }
  const r = run;
  if (!r) return;
  run = null;
  r.teardownStep?.();
  r.teardownRun?.();
  const index = useTourStore.getState().stepIndex;
  const step = r.def.steps[index];
  runCleanups(r);
  // On a model change, resetViewerState already normalized panels / tool /
  // selection for the NEW file - restoring the pre-tour snapshot over it
  // would be wrong. Everything else restores fully.
  if (reason !== 'model-change') {
    try {
      restoreUiSnapshot(getViewerStoreApi(), r.snapshot, []);
    } catch (err) {
      console.warn('[tours] snapshot restore failed:', err);
    }
  }
  storage.markTourAborted(r.def.id, index);
  telemetry.trackTourAbandoned(r.def.id, step?.id, index, reason);
  resetTourState();
}

/** True while a tour is running or its prerequisite interstitial is up. */
export function isTourActive(): boolean {
  return useTourStore.getState().status !== 'idle';
}

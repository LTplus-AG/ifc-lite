/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Schedule animator — compute per-product RGBA overrides for the current
 * playback time.
 *
 * Professional 4D tools (Synchro / Navisworks Timeliner / Fuzor) classify
 * each product into a *lifecycle phase* relative to its controlling task and
 * paint it according to (a) the task's PredefinedType and (b) the phase:
 *
 *     upcoming      — task hasn't started yet (optionally outside a
 *                     "look-ahead" window: hidden. Inside the window: ghost)
 *     preparation   — within `preparationDays` before start: ghost-blue
 *                     @ ~25 % opacity; signals imminent work
 *     ramp-in       — first `rampInFraction` of the task window: opacity
 *                     animates 0 → 1 (ease-out), painted in type-colour
 *     active        — middle of the task: solid task-type colour
 *     settling      — last `fadeOutFraction` of the window: type-colour
 *                     fades toward full transparency of *the override* (so
 *                     the real material shows through), not the product
 *     complete      — task finished: no override (material default)
 *
 * Demolition-like tasks (DEMOLITION / DISMANTLE / REMOVAL / DISPOSAL) invert
 * the lifecycle — the product exists normally before the task, fades out
 * with a red tint during the window, and is hidden afterwards.
 *
 * This module is pure. It reads a `ScheduleExtraction` + a time + settings
 * and returns a Map<expressId, RGBA> plus a hidden set. The caller wires the
 * Map into `pendingColorUpdates` and the hidden set into the visibility
 * layer.
 */

import type { ScheduleExtraction, ScheduleTaskInfo } from '@ifc-lite/parser';

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

export type RGBA = [number, number, number, number];

/**
 * All IfcTaskTypeEnum values (IFC4) plus an extra `PREPARATION` slot that
 * applies to every task during its look-ahead window, regardless of type.
 */
export type TaskPaletteKey =
  | 'ATTENDANCE' | 'CONSTRUCTION' | 'DEMOLITION' | 'DISMANTLE'
  | 'DISPOSAL' | 'INSTALLATION' | 'LOGISTIC' | 'MAINTENANCE'
  | 'MOVE' | 'OPERATION' | 'REMOVAL' | 'RENOVATION'
  | 'USERDEFINED' | 'NOTDEFINED'
  | 'PREPARATION';

export type TaskPalette = Record<TaskPaletteKey, RGBA>;

/**
 * Task-type palette aligned with Synchro's default conventions.
 *
 * RGB channels are chosen for decent contrast on both light and dark
 * viewport backgrounds; **alpha is 1.0 for task-type entries** because the
 * per-frame `paletteIntensity` setting (not the palette) is how users dial
 * how strongly the override paints over the real material.
 *
 * PREPARATION is treated separately — it's a ghost outline, not an active
 * paint, so it keeps its own alpha baked in.
 */
export const DEFAULT_PALETTE: TaskPalette = {
  CONSTRUCTION: [0.34, 0.76, 0.39, 1.0], // emerald green
  INSTALLATION: [0.40, 0.60, 0.95, 1.0], // royal blue
  DEMOLITION:   [0.88, 0.27, 0.27, 1.0], // red
  DISMANTLE:    [0.97, 0.55, 0.16, 1.0], // orange
  REMOVAL:      [0.86, 0.40, 0.25, 1.0], // red-orange
  DISPOSAL:     [0.55, 0.35, 0.18, 1.0], // brown
  RENOVATION:   [0.62, 0.42, 0.88, 1.0], // purple
  MAINTENANCE:  [0.92, 0.80, 0.22, 1.0], // amber
  LOGISTIC:     [0.32, 0.78, 0.85, 1.0], // cyan
  MOVE:         [0.58, 0.66, 0.90, 1.0], // lavender
  OPERATION:    [0.45, 0.80, 0.58, 1.0], // teal-green
  ATTENDANCE:   [0.75, 0.75, 0.80, 1.0], // cool grey
  USERDEFINED:  [0.55, 0.72, 0.86, 1.0], // soft blue
  NOTDEFINED:   [0.70, 0.70, 0.70, 1.0], // neutral grey
  // Darker, more saturated blue that reads as a distinct ghost on both
  // light and dark viewport backgrounds. The original light-blue @ 0.28
  // alpha was near-invisible against typical IFC material palettes.
  PREPARATION:  [0.20, 0.45, 0.80, 0.50],
};

/**
 * Enum values that represent "removing" work — products should be visible
 * before the task and faded/hidden after. IFC4's IfcTaskTypeEnum identifies
 * these explicitly; MOVE/RENOVATION are *not* removal by themselves.
 */
const REMOVAL_TASK_TYPES: ReadonlySet<string> = new Set([
  'DEMOLITION', 'DISMANTLE', 'REMOVAL', 'DISPOSAL',
]);

/**
 * Distinguishable lifecycle phase names. Callers don't need to branch on
 * these directly; they're exposed so UI can report a count per phase.
 */
export type LifecyclePhase =
  | 'upcoming-far'        // not within look-ahead window
  | 'upcoming-preparation' // within look-ahead window
  | 'active-ramp-in'
  | 'active'
  | 'active-settling'
  | 'complete'
  | 'removal-active'       // fading out during a demolition task
  | 'removal-complete';    // already demolished

export interface AnimationSettings {
  /**
   * `'minimal'` = only toggle hidden-ids per hard reveal (no colour/opacity
   * effects). `'phased'` = full lifecycle colouring from the palette below.
   */
  style: 'minimal' | 'phased';
  /** Days before task start that the preparation ghost is shown. */
  preparationDays: number;
  /** Fraction of the task window used for the ramp-in (0..0.5). */
  rampInFraction: number;
  /** Fraction of the task window used for the settling fade (0..0.5). */
  fadeOutFraction: number;
  /** Show ghost-blue preparation outline during the look-ahead window. */
  showPreparationGhost: boolean;
  /** Apply task-type colour during active phase. */
  colorizeByTaskType: boolean;
  /**
   * 0 = no palette override (pure visibility-timing mode even inside
   * `'phased'` style); 1 = full palette alpha. Multiplies the emitted
   * RGBA alpha for every active / ramp-in / settling / removal phase so
   * users can dial "subtle tint" vs. "saturated highlight" without
   * editing the palette itself. Does not affect the PREPARATION ghost,
   * which keeps its own baked alpha.
   */
  paletteIntensity: number;
  /** Animate DEMOLITION / DISMANTLE / REMOVAL / DISPOSAL as inverted fade. */
  animateDemolition: boolean;
  /**
   * Hide products whose task hasn't started and isn't in the preparation
   * window. When false, they render with the material default — useful if
   * the user wants to see the whole model at once with colour-coding only.
   */
  hideBeforePreparation: boolean;
  /** RGBA palette indexed by TaskPaletteKey. Defaults to DEFAULT_PALETTE. */
  palette: TaskPalette;
}

export const DEFAULT_ANIMATION_SETTINGS: AnimationSettings = {
  // Default is 'minimal' — pure visibility-timing with zero colour overlays.
  // The colour features are an opt-in power-user feature (see the popover's
  // style tiles). Users who load a model should see it animate cleanly by
  // default without any palette cast on top of their authoring.
  style: 'minimal',
  preparationDays: 2,
  rampInFraction: 0.08,
  fadeOutFraction: 0.10,
  // Off by default — the ghost is a power-user feature. Left on, it used
  // to paint the upper floors of a staged-from-top-down model nearly
  // white on light viewports.
  showPreparationGhost: false,
  colorizeByTaskType: true,
  // 0.6 is a sensible middle ground — the task-type colour reads clearly
  // but the underlying material still shows through. Users can push to 1.0
  // for a full Synchro-like paint or pull to 0 for purely visibility-timed.
  paletteIntensity: 0.6,
  animateDemolition: true,
  hideBeforePreparation: true,
  palette: DEFAULT_PALETTE,
};

export interface AnimationFrame {
  /** Per-expressId RGBA overrides for `scene.setColorOverrides`. */
  colorOverrides: Map<number, RGBA>;
  /** Products that should be *fully hidden* for this frame (upcoming-far). */
  hiddenIds: Set<number>;
  /** Human-readable per-phase counts for a debug / UI readout. */
  stats: Record<LifecyclePhase, number>;
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

/** Classic cubic ease-out, same shape used by the camera animator. */
function easeOutCubic(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - clamped, 3);
}

/** Mirror — used by the settling-phase fade so the override dissolves. */
function easeInCubic(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return clamped * clamped * clamped;
}

/**
 * Parse an ISO 8601 datetime → epoch ms. Identical to
 * `scheduleSlice.parseIsoDate`. We keep a local copy rather than importing
 * from `@/store` because `scheduleSlice` already imports from this module
 * for `AnimationSettings` / `DEFAULT_ANIMATION_SETTINGS` — sharing the
 * helper through `@/store` closes the loop and breaks ESM initialisation
 * order ("Cannot access X before initialization"). Any fix to TZ-less
 * normalization must land in both copies; linked via comment.
 */
function parseEpoch(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const hasTz = /Z$|[+-]\d{2}:?\d{2}$/.test(value);
  const t = Date.parse(hasTz ? value : `${value}Z`);
  return Number.isNaN(t) ? undefined : t;
}

function taskWindow(task: ScheduleTaskInfo): { start: number; finish: number } | null {
  const start = parseEpoch(task.taskTime?.scheduleStart ?? task.taskTime?.actualStart);
  const finish = parseEpoch(task.taskTime?.scheduleFinish ?? task.taskTime?.actualFinish);
  if (start === undefined || finish === undefined || finish < start) return null;
  return { start, finish };
}

function resolvePaletteKey(predefinedType: string | undefined): TaskPaletteKey {
  if (!predefinedType) return 'NOTDEFINED';
  const upper = predefinedType.toUpperCase();
  if (upper in DEFAULT_PALETTE) return upper as TaskPaletteKey;
  return 'USERDEFINED';
}

function isRemovalTask(task: ScheduleTaskInfo): boolean {
  return REMOVAL_TASK_TYPES.has((task.predefinedType ?? '').toUpperCase());
}

/** Merge RGBA b over a using the `a.alpha` and `b.alpha` terms — standard
 *  "src-over" compositing. Only used for emptyPhase initialization. */
function withAlpha(rgba: RGBA, alpha: number): RGBA {
  return [rgba[0], rgba[1], rgba[2], Math.min(1, Math.max(0, alpha))];
}

const MS_PER_DAY = 86_400_000;

// ─────────────────────────────────────────────────────────────────────────
// Per-task phase computation
// ─────────────────────────────────────────────────────────────────────────

interface PhaseResult {
  phase: LifecyclePhase;
  /** RGBA to apply (undefined = no override = render material default). */
  color?: RGBA;
  /** True if the product should be hidden instead of coloured. */
  hide: boolean;
}

function computeTaskPhase(
  task: ScheduleTaskInfo,
  playbackTime: number,
  settings: AnimationSettings,
): PhaseResult | null {
  const win = taskWindow(task);
  if (!win) return null;
  const { start, finish } = win;
  const duration = Math.max(1, finish - start);
  const prepStart = start - settings.preparationDays * MS_PER_DAY;
  const typeKey = resolvePaletteKey(task.predefinedType);
  const typeColor = settings.palette[typeKey] ?? settings.palette.NOTDEFINED;
  const prepColor = settings.palette.PREPARATION;
  // Clamp once; 0 disables task-type painting entirely even in 'phased'.
  const intensity = Math.min(1, Math.max(0, settings.paletteIntensity));
  // Helper: palette alpha × user intensity. Kept inline rather than lifted
  // to the module scope because it closes over `typeColor[3]`.
  const paint = (alpha: number): RGBA => [
    typeColor[0], typeColor[1], typeColor[2],
    Math.min(1, Math.max(0, alpha * typeColor[3] * intensity)),
  ];

  // ── Removal-like tasks invert the lifecycle ──────────────────────────
  if (settings.animateDemolition && isRemovalTask(task)) {
    if (playbackTime < start) {
      // Before demolition starts — product exists normally.
      return { phase: 'upcoming-far', hide: false };
    }
    if (playbackTime > finish) {
      return { phase: 'removal-complete', hide: true };
    }
    const p = (playbackTime - start) / duration;
    // Fade red tint in and overall override alpha out. Intensity modulates
    // the peak — `intensity=0` means the tint is never visible (the product
    // simply disappears at `finish`).
    return { phase: 'removal-active', hide: false, color: paint(1 - easeInCubic(p)) };
  }

  // ── Standard construction lifecycle ──────────────────────────────────
  if (playbackTime < prepStart) {
    return {
      phase: 'upcoming-far',
      hide: settings.hideBeforePreparation,
    };
  }

  if (playbackTime < start) {
    if (!settings.showPreparationGhost) {
      return { phase: 'upcoming-preparation', hide: settings.hideBeforePreparation };
    }
    return { phase: 'upcoming-preparation', hide: false, color: prepColor };
  }

  if (playbackTime <= finish) {
    // colorizeByTaskType=false → phase is tracked for stats but no override;
    // paletteIntensity=0 is the same effect without changing the toggle.
    if (!settings.colorizeByTaskType || intensity === 0) {
      return { phase: 'active', hide: false };
    }
    const p = (playbackTime - start) / duration;
    if (p < settings.rampInFraction) {
      const t = p / Math.max(0.001, settings.rampInFraction);
      return {
        phase: 'active-ramp-in',
        hide: false,
        color: paint(easeOutCubic(t)),
      };
    }
    if (p > 1 - settings.fadeOutFraction) {
      const t = (p - (1 - settings.fadeOutFraction)) / Math.max(0.001, settings.fadeOutFraction);
      return {
        phase: 'active-settling',
        hide: false,
        color: paint(1 - easeInCubic(t)),
      };
    }
    return { phase: 'active', hide: false, color: paint(1) };
  }

  // After finish — rendered as material default.
  return { phase: 'complete', hide: false };
}

// ─────────────────────────────────────────────────────────────────────────
// Public — computeAnimationFrame
// ─────────────────────────────────────────────────────────────────────────

/**
 * Compute a frame of animation for the given playback time.
 *
 * Products with multiple controlling tasks take the *most-relevant* one:
 * an active/ramp/settling task wins over preparation, which wins over
 * upcoming-far, which wins over complete. Removal tasks are always
 * preferred over construction tasks (their span dominates the product's
 * visual state).
 */
export function computeAnimationFrame(
  data: ScheduleExtraction | null,
  playbackTime: number,
  settings: AnimationSettings,
  scheduleGlobalId?: string | null,
): AnimationFrame {
  const colorOverrides = new Map<number, RGBA>();
  const hiddenIds = new Set<number>();
  const stats: Record<LifecyclePhase, number> = {
    'upcoming-far': 0,
    'upcoming-preparation': 0,
    'active-ramp-in': 0,
    'active': 0,
    'active-settling': 0,
    'complete': 0,
    'removal-active': 0,
    'removal-complete': 0,
  };

  if (!data || data.tasks.length === 0) {
    return { colorOverrides, hiddenIds, stats };
  }

  /** Phase priority used to pick the "winning" task for a product. */
  const phasePriority: Record<LifecyclePhase, number> = {
    'removal-active': 90,
    'removal-complete': 80,
    'active-ramp-in': 70,
    'active-settling': 65,
    'active': 60,
    'upcoming-preparation': 40,
    'upcoming-far': 20,
    'complete': 10,
  };

  /**
   * Two-layer separation: *timing* (hiddenIds) is always emitted regardless
   * of style so minimal mode still removes demolished products and hides
   * upcoming ones. *Colour overlays* only emit when style === 'phased'.
   */
  const emitColours = settings.style === 'phased';

  /** Per-product chosen phase so we resolve multi-task conflicts. */
  const chosenByProduct = new Map<number, PhaseResult>();

  for (const task of data.tasks) {
    if (scheduleGlobalId
        && task.controllingScheduleGlobalIds.length > 0
        && !task.controllingScheduleGlobalIds.includes(scheduleGlobalId)) {
      continue;
    }
    if (task.productExpressIds.length === 0) continue;
    const phase = computeTaskPhase(task, playbackTime, settings);
    if (!phase) continue;

    for (const id of task.productExpressIds) {
      const existing = chosenByProduct.get(id);
      if (!existing || phasePriority[phase.phase] > phasePriority[existing.phase]) {
        chosenByProduct.set(id, phase);
      }
    }
  }

  for (const [id, result] of chosenByProduct) {
    stats[result.phase] += 1;
    if (result.hide) {
      hiddenIds.add(id);
      continue;
    }
    if (emitColours && result.color) {
      colorOverrides.set(id, result.color);
    }
  }

  return { colorOverrides, hiddenIds, stats };
}

// Re-export internal helpers for unit tests
export const __testing = { computeTaskPhase, resolvePaletteKey, isRemovalTask, parseEpoch };

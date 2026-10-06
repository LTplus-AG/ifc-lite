/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The sampled field events for the journeys `ifc_model_loaded` does not cover
 * (#6961, charter #6954). Lives in the on-demand field chunk; the viewer's
 * call sites reach it through `fieldTelemetry` (a live binding that stays
 * null until the chunk has loaded), so an unloaded chunk costs one null check.
 *
 * Sample rates, and why:
 *
 * - `ifc_inspect` (click -> properties panel populated): 10% of viewport
 *   selection clicks, at most 10 per page session. Clicks outnumber loads by
 *   an order of magnitude, and the paired ratio needs a few samples per person
 *   in each window, not every click; 10% keeps the volume near the load event's.
 * - `ifc_navigate` (camera-interaction frame interval p50/p95): once per page
 *   session, after 120 interaction frames, every session. One row per session
 *   is already the cap, and the ratio needs every person it can get.
 * - `viewer_boot` (navigation -> drop target interactive, engine wasm
 *   compiled): once per page load, every page load, the same volume as
 *   `viewer_session_started`.
 *
 * Privacy: numbers, closed vocabularies and the perf-flag arm only; the model
 * is identified by `file_size_mb`, exactly as `ifc_model_loaded` identifies it.
 * Every capture goes through the consent-aware `posthog` facade and `scrubEvent`.
 */

import { posthog } from '../analytics.js';
import { useViewerStore } from '../../store/index.js';
import { getModelLoadedSnapshot } from '../../utils/loadTelemetry.js';
import { visibilityWitness } from '../../utils/visibilityWitness.js';
import { perfFlagArm } from './fieldArm.js';

export const INSPECT_SAMPLE_RATE = 0.1;
export const INSPECT_MAX_PER_SESSION = 10;
/** A click whose selection or panel lands later than this is not this click's. */
const INSPECT_WINDOW_MS = 5_000;
export const NAVIGATE_FRAMES = 120;
/** A frame interval this long is a stall or a background tab, not a frame. */
const NAVIGATE_MAX_FRAME_MS = 1_000;
/** `viewer_boot` goes out with what it has this long after the chunk loaded. */
const BOOT_DEADLINE_MS = 30_000;

type Props = Record<string, string | number | boolean | undefined>;
const now = () => globalThis.performance.now();
const nextPaint = (fn: () => void) => (globalThis.requestAnimationFrame ? globalThis.requestAnimationFrame(() => fn()) : fn());

function modelProps(): Props {
  const snapshot = getModelLoadedSnapshot();
  return snapshot ? { file_size_mb: Math.round(snapshot.fileSizeMB * 100) / 100, mesh_count: snapshot.meshCount } : {};
}

let random: () => number = Math.random;

// ── ifc_inspect ────────────────────────────────────────────────────────────
let clickAt: number | null = null;
let armed: { at: number; globalId: number; hidden: () => boolean } | null = null;
let inspectsSent = 0;

/** A viewport selection click started at `at` (event time, `performance.now()` clock). */
export function noteInspectClick(at: number): void {
  clickAt = inspectsSent < INSPECT_MAX_PER_SESSION && random() < INSPECT_SAMPLE_RATE ? at : null;
}

/** The click's pick resolved to `globalId` (null: a miss, nothing to inspect). */
export function noteInspectSelection(globalId: number | null): void {
  const at = clickAt;
  clickAt = null;
  armed = at !== null && globalId !== null && now() - at < INSPECT_WINDOW_MS ? { at, globalId, hidden: visibilityWitness() } : null;
}

/** The properties panel committed `globalId`'s properties; the event is sent on the next paint. */
export function noteInspectPopulated(globalId: number): void {
  const pending = armed;
  if (!pending || pending.globalId !== globalId) return;
  armed = null;
  nextPaint(() => {
    const ms = now() - pending.at;
    if (ms > INSPECT_WINDOW_MS) return;
    inspectsSent++;
    posthog.capture('ifc_inspect', { journey: 'J5', inspect_ms: Math.round(ms), was_hidden: pending.hidden(), perf_flags: perfFlagArm(), ...modelProps() });
  });
}

// ── ifc_navigate ───────────────────────────────────────────────────────────
const frames = new Float64Array(NAVIGATE_FRAMES);
let frameCount = 0;
let interacting = false;
let navigateSent = false;

const percentile = (sorted: Float64Array, p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];

/**
 * One animation-loop frame. Only frames inside a camera interaction count,
 * the first of each interaction is dropped (it measures the idle gap before
 * it), and so are frames while geometry streams or the tab is hidden.
 */
export function noteNavigateFrame(deltaMs: number, isInteracting: boolean): void {
  if (navigateSent) return;
  const wasInteracting = interacting;
  interacting = isInteracting;
  if (!isInteracting || !wasInteracting) return;
  if (!(deltaMs > 0 && deltaMs < NAVIGATE_MAX_FRAME_MS)) return;
  if (globalThis.document?.visibilityState === 'hidden' || useViewerStore.getState().geometryStreamingActive) return;
  frames[frameCount++] = deltaMs;
  if (frameCount < NAVIGATE_FRAMES) return;
  navigateSent = true;
  const sorted = frames.slice().sort();
  posthog.capture('ifc_navigate', {
    journey: 'J6',
    frame_p50_ms: Math.round(percentile(sorted, 0.5) * 10) / 10,
    frame_p95_ms: Math.round(percentile(sorted, 0.95) * 10) / 10,
    frame_max_ms: Math.round(sorted[sorted.length - 1] * 10) / 10,
    frame_count: NAVIGATE_FRAMES,
    perf_flags: perfFlagArm(),
    ...modelProps(),
  });
}

// ── viewer_boot ────────────────────────────────────────────────────────────
const boot: { dropTargetMs?: number; compiledMs?: number; compileMs?: number; compiled?: boolean } = {};
let bootSent = false;
let firstLoadAt: number | null = null;
let bootTimer: ReturnType<typeof setTimeout> | null = null;
const bootHidden = visibilityWitness();
const bootStartedHidden = globalThis.document?.visibilityState === 'hidden';

function sendBoot(): void {
  if (bootSent) return;
  bootSent = true;
  if (bootTimer !== null) clearTimeout(bootTimer);
  const props: Props = {
    journey: 'J0',
    drop_target_ms: boot.dropTargetMs,
    engine_wasm_compiled_ms: boot.compiledMs,
    engine_wasm_compile_ms: boot.compileMs,
    engine_wasm_compiled: boot.compiled,
    // Before this chunk loaded the witness was not listening; a tab hidden
    // at that point is still caught by the state check.
    was_hidden: bootStartedHidden || bootHidden(),
    perf_flags: perfFlagArm(),
  };
  for (const key of Object.keys(props)) if (props[key] === undefined) delete props[key];
  posthog.capture('viewer_boot', props);
}

function maybeSendBoot(): void {
  if (boot.dropTargetMs !== undefined && boot.compiled !== undefined) sendBoot();
  else bootTimer ??= setTimeout(sendBoot, BOOT_DEADLINE_MS);
}

/** A load started: a drop target interactive after this is no longer a boot measurement. */
export function noteLoadStarted(at: number): void { firstLoadAt ??= at; }

/** The empty viewer's drop target became interactive at `at` (ms since navigation). */
export function noteDropTargetInteractive(at: number): void {
  if (bootSent || firstLoadAt !== null || boot.dropTargetMs !== undefined) return;
  boot.dropTargetMs = Math.round(at);
  maybeSendBoot();
}

/**
 * The boot prewarm settled: it began at `startedAt` and ended at `endedAt`
 * (both ms since navigation). The compile time is only stated when no load
 * had started first, because a load joins the same compile and the prewarm
 * then measures the tail of someone else's work.
 */
export function noteEngineCompiled(startedAt: number, endedAt: number, compiled: boolean): void {
  if (bootSent || boot.compiled !== undefined) return;
  boot.compiled = compiled;
  if (compiled) {
    boot.compiledMs = Math.round(endedAt);
    if (firstLoadAt === null || firstLoadAt >= endedAt) boot.compileMs = Math.round(endedAt - startedAt);
  }
  maybeSendBoot();
}

/** Test seam: send `viewer_boot` now instead of at its deadline. */
export function flushViewerBootForTests(): void { sendBoot(); }

/** Test seam: fresh per-session latches and an injectable sampler. */
export function resetFieldEventsForTests(sampler: () => number = Math.random): void {
  random = sampler;
  clickAt = null; armed = null; inspectsSent = 0;
  frameCount = 0; interacting = false; navigateSent = false;
  for (const key of Object.keys(boot) as Array<keyof typeof boot>) delete boot[key];
  bootSent = false; firstLoadAt = null;
  if (bootTimer !== null) clearTimeout(bootTimer);
  bootTimer = null;
}

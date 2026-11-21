/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { JSONSchemaType } from 'ajv';
import { useViewerStore } from '@/store';
import { acquireScheduleRuntime, holdBoundedSchedulePlayback } from '@/lib/schedule/runtime';
import type { ToolHost } from '../types';
import { operation, viewerOperation } from './contract';
import { metadata, checkpoint } from './analytics-common';
import { invalidInput, unavailable } from './refusals';
const runtimes = new WeakMap<ToolHost, () => void>();
function ensureRuntime(host: ToolHost) {
  if (!host.lifetimeSignal) return acquireScheduleRuntime();
  if (runtimes.has(host)) return;
  const release = acquireScheduleRuntime(); runtimes.set(host, release);
  host.lifetimeSignal?.addEventListener('abort', () => { release(); runtimes.delete(host); }, { once: true });
}
const resultSchema = { type: 'object', properties: { state: { type: 'string', enum: ['succeeded', 'cancelled', 'failed'] }, time: { type: 'number' }, reason: { type: ['string', 'null'] } }, required: ['state', 'time', 'reason'], additionalProperties: false };
export const analyticsSchedulePlaybackOperations = [
  operation<{ until: number; max_real_seconds: number }>(metadata('schedule.play', 'gantt', 'Play the native 4D timeline and overlay through the same single clock/runtime as the panel. Await the requested simulated time, native pause, cancellation, source replacement or bounded real-time expiry; never treat starting playback as completion.', ['view', 'configuration'], resultSchema), {
    type: 'object', properties: { until: { type: 'number' }, max_real_seconds: { type: 'number', minimum: 0.1, maximum: 120 } }, required: ['until', 'max_real_seconds'], additionalProperties: false,
  } satisfies JSONSchemaType<{ until: number; max_real_seconds: number }>, async (i, c) => {
    const initial = useViewerStore.getState(); const data = initial.scheduleData;
    if (!data || !initial.scheduleRange || initial.scheduleSourceModelId !== c.model.id) throw unavailable('Initialize the exact target-model native schedule first.');
    if (initial.playbackIsPlaying) throw unavailable('A native schedule playback is already running.');
    if (!(i.until > initial.playbackTime && i.until >= initial.scheduleRange.start && i.until <= initial.scheduleRange.end)) throw invalidInput('invalid-value', 'Choose a stop time after the current time and within the native schedule range.');
    if (typeof requestAnimationFrame !== 'function') throw unavailable('The native animation clock host is unavailable.');
    checkpoint(c); const releaseRuntime = ensureRuntime(c.host);
    return new Promise<{ state: 'succeeded' | 'cancelled' | 'failed'; time: number; reason: string | null }>((resolve, reject) => {
      let releaseBounded: (() => void) | undefined;
      let settled = false; let started = false; let unsubscribe: (() => void) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (state: 'succeeded' | 'cancelled' | 'failed', reason: string | null) => {
        if (settled) return; settled = true; unsubscribe?.(); if (timer !== undefined) clearTimeout(timer);
        c.signal?.removeEventListener('abort', cancelled); c.host.lifetimeSignal?.removeEventListener('abort', cancelled);
        // Stopping this admitted clock is cleanup, including after grant revocation.
        useViewerStore.getState().pauseSchedule(); releaseBounded?.(); releaseRuntime?.(); resolve({ state, time: useViewerStore.getState().playbackTime, reason });
      };
      const cancelled = () => finish('cancelled', 'Playback cancelled; previously applied frames remain visible.');
      unsubscribe = useViewerStore.subscribe(state => {
        if (settled || !started) return;
        try { checkpoint(c); } catch (error) { finish('cancelled', error instanceof Error ? error.message : String(error)); return; }
        if (state.scheduleData !== data || state.scheduleSourceModelId !== c.model.id) { finish('failed', 'Native schedule was replaced during playback.'); return; }
        if (!state.animationEnabled) { finish('cancelled', 'Native animation was disabled during playback.'); return; }
        if (state.playbackTime >= i.until) finish('succeeded', null);
        else if (!state.playbackIsPlaying) finish('cancelled', 'Native playback was paused before the requested time.');
      });
      c.signal?.addEventListener('abort', cancelled, { once: true }); c.host.lifetimeSignal?.addEventListener('abort', cancelled, { once: true });
      timer = setTimeout(() => finish('failed', 'Native playback exceeded its real-time budget.'), i.max_real_seconds * 1000);
      try { c.commit(() => { releaseBounded = holdBoundedSchedulePlayback(); started = true; initial.playSchedule(); }); }
      catch (error) { unsubscribe(); clearTimeout(timer); c.signal?.removeEventListener('abort', cancelled); c.host.lifetimeSignal?.removeEventListener('abort', cancelled); settled = true; releaseBounded?.(); releaseRuntime?.(); reject(error); }
    });
  }),
  viewerOperation<{ respect_work_calendar: boolean }>(metadata('schedule.workCalendarPlayback', 'gantt', 'Set the native playback work-calendar switch.', ['configuration'], { type: 'object', properties: { respect_work_calendar: { type: 'boolean' } }, required: ['respect_work_calendar'], additionalProperties: false }), {
    type: 'object', properties: { respect_work_calendar: { type: 'boolean' } }, required: ['respect_work_calendar'], additionalProperties: false,
  } satisfies JSONSchemaType<{ respect_work_calendar: boolean }>, (i, c) => { checkpoint(c); c.commit(() => useViewerStore.getState().setRespectWorkCalendar(i.respect_work_calendar)); return i; }),
];

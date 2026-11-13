/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Diagnostic report sections of load-scoreboard-report.mjs that read rows directly (no verdict logic). */

import { median } from './load-scoreboard-stats.mjs';

/**
 * Per fixture x lane x side: how many samples had WebGL (the start screen's mark) drawing around the pick, and the
 * median canvas frames to interactive. A cell mixing both states is MIXED: on Xvfb the two states present at very
 * different cost, so its spread is part harness, not product.
 */
export function webglPickRows(samples) {
  const groups = new Map();
  for (const r of samples) {
    if (!r.ok || !String(r.lane).startsWith('browser-') || !('webglActiveAtPick' in r)) continue;
    const key = `${r.fixture}|${r.lane}|${r.side}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return [...groups].map(([key, rows]) => {
    const [fixture, lane, side] = key.split('|');
    const known = rows.filter((r) => typeof r.webglActiveAtPick === 'boolean');
    const active = known.filter((r) => r.webglActiveAtPick).length;
    const frames = rows.map((r) => r.framesToInteractive).filter(Number.isFinite);
    const knownState = known.length === 0 ? 'UNKNOWN' : active === 0 ? 'none' : active === known.length ? 'ALL' : 'MIXED';
    const unknown = rows.length - known.length;
    const state = known.length > 0 && unknown > 0 ? `${knownState} (+${unknown} unknown)` : knownState;
    return `| ${fixture} | ${lane} | ${side} | ${rows.length} | ${active} | ${state} | ${frames.length ? Math.round(median(frames)) : '—'} |`;
  });
}

/**
 * Per fixture x lane x side: samples that overlapped a host watchdog pass (host.overlapsWatchdogPass) and the median CPU
 * the rest of the host used during the overlapping ones (host.foreignCpuMs). Measurement only: affected cells are named, not voided.
 */
export function watchdogRows(samples) {
  const groups = new Map();
  for (const r of samples) {
    if (!r.ok || !String(r.lane).startsWith('browser-') && r.lane !== 'native-cold') continue;
    if (!r.host || !('overlapsWatchdogPass' in r.host)) continue;
    const key = `${r.fixture}|${r.lane}|${r.side}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return [...groups].filter(([, rows]) => rows.some((r) => r.host.overlapsWatchdogPass !== false)).map(([key, rows]) => {
    const [fixture, lane, side] = key.split('|');
    const over = rows.filter((r) => r.host.overlapsWatchdogPass === true).length;
    const unknown = rows.filter((r) => r.host.overlapsWatchdogPass === null).length;
    const foreign = rows.filter((r) => r.host.overlapsWatchdogPass === true).map((r) => r.host.foreignCpuMs).filter(Number.isFinite);
    return `| ${fixture} | ${lane} | ${side} | ${rows.length} | ${over} | ${unknown} | ${foreign.length ? Math.round(median(foreign)) : '—'} |`;
  });
}

/**
 * Per fixture x lane x side: samples during which the CPU package throttled (host.thermal.throttleEvents > 0), samples
 * whose thermal counters could not be read, and the hottest package temperature at a sample start or end. Measurement
 * only (Pop ran at 91-94 C on 2026-11-12): cells are named, not voided. Cells with nothing to show are omitted.
 */
export function thermalRows(samples) {
  const groups = new Map();
  for (const r of samples) {
    if (!r.ok || !r.host || !('thermal' in r.host)) continue;
    const key = `${r.fixture}|${r.lane}|${r.side}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return [...groups].map(([key, rows]) => {
    const [fixture, lane, side] = key.split('|');
    // Throttling already active at the start adds time without a new event, so either counter moving counts;
    // either counter unreadable makes the sample unknown (review #9952).
    const throttled = rows.filter((r) => r.host.thermal?.throttleEvents > 0 || r.host.thermal?.throttleMs > 0).length;
    const unknown = rows.filter((r) => !Number.isFinite(r.host.thermal?.throttleEvents) || !Number.isFinite(r.host.thermal?.throttleMs)).length;
    const temps = rows.flatMap((r) => [r.host.thermal?.startC, r.host.thermal?.endC]).filter(Number.isFinite);
    const ms = rows.map((r) => r.host.thermal?.throttleMs).filter(Number.isFinite);
    return { throttled, unknown, line: `| ${fixture} | ${lane} | ${side} | ${rows.length} | ${throttled} | ${unknown} | ${ms.length ? Math.max(...ms) : '—'} | ${temps.length ? Math.max(...temps) : '—'} |` };
  }).filter((x) => x.throttled > 0 || x.unknown > 0).map((x) => x.line);
}

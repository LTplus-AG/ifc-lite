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

/** One side's arming protocol on a `-settled` lane: the distinct boot-signal outcomes and the median signal wait. */
export function armProtocolOf(ok) {
  const signals = [...new Set(ok.map((r) => String(r.shell?.bootSettled ?? 'not recorded')))].sort();
  return { signals, waitMedianMs: median(ok.map((r) => r.shell?.bootSettledWaitMs).filter(Number.isFinite)) };
}

/** A sample "hits the post-finalize stall" when its first frame after the scene finished comes more than this long after the mark. */
export const STALL_MS = 50;

/**
 * The second, informational mark of one browser row: the first frame the renderer started (canvas texture acquired,
 * `getCurrentTexture`) at or after the scene finished (finalize end, `geometryMs`), never earlier than the current mark.
 * Texture acquisition starts a frame; it is not the compositor's presentation time, so this mark is a lower bound on
 * the frame the user sees. `waitMs` = how far it is after the current mark. Null when the row has no frame times or
 * none falls in its window (unknown, never "no wait"). An early-arm row (`rebaseToArm`: milestones moved to the
 * first-paint clock by `pickDelayMs`) has its frame times, recorded on the change-event clock, moved by the same delay.
 */
export function frameMarkOf(row) {
  const times = row?.presentTimesFromChangeMs, g = row?.geometryMs, i = row?.interactiveMs;
  if (!Array.isArray(times) || !Number.isFinite(g) || !Number.isFinite(i)) return null;
  const shift = Number.isFinite(row?.pickDelayMs) ? row.pickDelayMs : 0;
  const next = times.map((t) => t + shift).find((t) => t >= g - 1e-6);
  if (next === undefined) return null;
  const frameMs = Math.max(i, next);
  return { frameMs, waitMs: frameMs - i };
}

/** Fewer samples than this are listed, never summarized (the report's rule in `renderMarkdown`). */
const MIN_SUMMARY = 3;

/**
 * Both marks for one lane, per side, from the same samples: the current mark (what verdicts use) and the frame mark,
 * with the share of samples that hit the post-finalize stall (wait > STALL_MS) and the gains under both marks. The
 * frame gain needs every sample on both sides to have a frame mark: a median over a smaller cohort than the current
 * one could show a gain made by the missing samples alone, so with any unknown it is null. Verdicts stay on the
 * current mark; this makes an uneven tail visible beside it.
 */
export function bothMarksCell(rows) {
  const side = (name) => {
    const ok = rows.filter((r) => r.side === name && r.ok && Number.isFinite(r.interactiveMs));
    const marks = ok.map(frameMarkOf);
    const known = marks.filter(Boolean);
    return { n: ok.length, current: median(ok.map((r) => r.interactiveMs)), frame: known.length ? median(known.map((m) => m.frameMs)) : null,
      currentValues: ok.map((r) => r.interactiveMs), frameValues: known.map((m) => m.frameMs),
      stalls: known.filter((m) => m.waitMs > STALL_MS).length, known: known.length, unknown: ok.length - known.length,
      maxWaitMs: known.length ? Math.max(...known.map((m) => m.waitMs)) : null };
  };
  const base = side('base'), branch = side('branch');
  const enough = base.n >= MIN_SUMMARY && branch.n >= MIN_SUMMARY;
  const gain = (a, b) => (enough && Number.isFinite(a) && Number.isFinite(b) && a > 0 ? 1 - b / a : null);
  const sameCohort = base.unknown === 0 && branch.unknown === 0;
  return { base, branch, gainCurrent: gain(base.current, branch.current), gainFrame: sameCohort ? gain(base.frame, branch.frame) : null };
}

/** Markdown rows of the both-marks table (lanes with no frame times on either side are omitted). */
export function bothMarksRows(fixtures) {
  const ms = (v) => (Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : '—');
  // Fewer than MIN_SUMMARY values: list them (the report never summarizes them).
  // Counted per column: a side with three samples but two known frame marks lists those two.
  const val = (median, values) => (values?.length >= MIN_SUMMARY ? ms(median) : values?.length ? `n=${values.length}: ${values.map(ms).join(', ')}` : '—');
  const pct = (v) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%` : '—');
  const share = (x) => (x.known ? `${x.stalls}/${x.known}${x.unknown ? ` (+${x.unknown} unknown)` : ''}` : `unknown (${x.unknown})`);
  const out = [];
  for (const f of fixtures) for (const [lane, l] of Object.entries(f.lanes)) {
    const c = l.bothMarks;
    if (!c || (c.base.known === 0 && c.branch.known === 0)) continue;
    const { base: b, branch: r } = c;
    out.push(`| ${f.name} | ${lane} | ${val(b.current, b.currentValues)} | ${val(b.frame, b.frameValues)} | ${share(b)} | ${val(r.current, r.currentValues)} | ${val(r.frame, r.frameValues)} | ${share(r)} | ${pct(c.gainCurrent)} | ${pct(c.gainFrame)} |`);
  }
  return out;
}

/** The both-marks section's markdown lines, or none when no lane has presented-frame times. */
export function bothMarksSection(fixtures) {
  const rows = bothMarksRows(fixtures);
  return rows.length ? ['', `## Both marks (verdicts use the current mark; "frame" = first frame started (canvas texture acquired) at or after the scene finished; frame gain only when every sample has a frame mark; stall = next frame > ${STALL_MS} ms after the mark)`, '',
    '| fixture | lane | base current | base frame | base stalls | branch current | branch frame | branch stalls | gain (current) | gain (frame) |', '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|', ...rows] : [];
}

/**
 * Per fixture x lane x side: samples during which the CPU package throttled (host.thermal.throttleEvents > 0), samples
 * whose thermal counters could not be read, and the hottest package temperature at a sample start or end. Measurement
 * only (Pop ran at 91-94 C on 2026-11-12): cells are named, not voided. Cells with nothing to show are omitted.
 */
// The kernel counts a package throttle event when it starts and adds its time only when it ends, so an episode
// that began before a sample and lasts through it moves neither counter. A package at or above HOT_C (the fleet's
// 90 C admission gate, where Pop throttles) at either end of a sample is therefore reported as hot, never as quiet;
// and a sample's throttle ms may include time from before it (review #9952).
export const HOT_C = 90;

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
    const hot = rows.filter((r) => Math.max(r.host.thermal?.startC ?? -Infinity, r.host.thermal?.endC ?? -Infinity) >= HOT_C).length;
    const temps = rows.flatMap((r) => [r.host.thermal?.startC, r.host.thermal?.endC]).filter(Number.isFinite);
    const ms = rows.map((r) => r.host.thermal?.throttleMs).filter(Number.isFinite);
    return { throttled, unknown, hot, line: `| ${fixture} | ${lane} | ${side} | ${rows.length} | ${throttled} | ${hot} | ${unknown} | ${ms.length ? Math.max(...ms) : '—'} | ${temps.length ? Math.max(...temps) : '—'} |` };
  }).filter((x) => x.throttled > 0 || x.hot > 0 || x.unknown > 0).map((x) => x.line);
}

/** The thermal section's markdown lines, or none when no cell has a throttled or unreadable sample. */
export function thermalSection(samples) {
  const rows = thermalRows(samples);
  return rows.length ? ['', '## CPU package thermal throttling during samples (measurement only, cells not voided)', '',
    '| fixture | lane | side | samples | throttled | at or above 90 C | unreadable | max throttle ms in a sample | hottest package C |', '|---|---|---|---:|---:|---:|---:|---:|---:|', ...rows] : [];
}


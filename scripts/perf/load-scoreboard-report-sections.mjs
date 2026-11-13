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

/** A sample "hits the post-finalize stall" when its first presented frame comes more than this long after the mark. */
export const STALL_MS = 50;

/**
 * The second, informational mark of one browser row: the first frame presented at or after the scene finished
 * (finalize end, `geometryMs`), never earlier than the current mark. `waitMs` = how far it is after the current
 * mark. Null when the row has no presented-frame times or none falls in its window (unknown, never "no wait").
 */
export function frameMarkOf(row) {
  const times = row?.presentTimesFromChangeMs, g = row?.geometryMs, i = row?.interactiveMs;
  if (!Array.isArray(times) || !Number.isFinite(g) || !Number.isFinite(i)) return null;
  const next = times.find((t) => t >= g - 1e-6);
  if (next === undefined) return null;
  const frameMs = Math.max(i, next);
  return { frameMs, waitMs: frameMs - i };
}

/**
 * Both marks for one lane, per side, from the same samples: the current mark (what verdicts use) and the
 * presented-frame mark, with the share of samples that hit the post-finalize stall (wait > STALL_MS) and the
 * gains under both marks. Verdicts stay on the current mark; this makes an uneven tail visible beside it.
 */
export function bothMarksCell(rows) {
  const side = (name) => {
    const ok = rows.filter((r) => r.side === name && r.ok && Number.isFinite(r.interactiveMs));
    const marks = ok.map(frameMarkOf);
    const known = marks.filter(Boolean);
    return { n: ok.length, current: median(ok.map((r) => r.interactiveMs)), frame: known.length ? median(known.map((m) => m.frameMs)) : null,
      stalls: known.filter((m) => m.waitMs > STALL_MS).length, known: known.length, unknown: ok.length - known.length,
      maxWaitMs: known.length ? Math.max(...known.map((m) => m.waitMs)) : null };
  };
  const base = side('base'), branch = side('branch');
  const gain = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && a > 0 ? 1 - b / a : null);
  return { base, branch, gainCurrent: gain(base.current, branch.current), gainFrame: gain(base.frame, branch.frame) };
}

/** Markdown rows of the both-marks table (lanes with no presented-frame times on either side are omitted). */
export function bothMarksRows(fixtures) {
  const ms = (v) => (Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : '—');
  const pct = (v) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%` : '—');
  const share = (x) => (x.known ? `${x.stalls}/${x.known}${x.unknown ? ` (+${x.unknown} unknown)` : ''}` : `unknown (${x.unknown})`);
  const out = [];
  for (const f of fixtures) for (const [lane, l] of Object.entries(f.lanes)) {
    const c = l.bothMarks;
    if (!c || (c.base.known === 0 && c.branch.known === 0)) continue;
    out.push(`| ${f.name} | ${lane} | ${ms(c.base.current)} | ${ms(c.base.frame)} | ${share(c.base)} | ${ms(c.branch.current)} | ${ms(c.branch.frame)} | ${share(c.branch)} | ${pct(c.gainCurrent)} | ${pct(c.gainFrame)} |`);
  }
  return out;
}

/** The both-marks section's markdown lines, or none when no lane has presented-frame times. */
export function bothMarksSection(fixtures) {
  const rows = bothMarksRows(fixtures);
  return rows.length ? ['', `## Both marks (verdicts use the current mark; "frame" = first frame presented at or after the scene finished; stall = next frame > ${STALL_MS} ms after the mark)`, '',
    '| fixture | lane | base current | base frame | base stalls | branch current | branch frame | branch stalls | gain (current) | gain (frame) |', '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|', ...rows] : [];
}


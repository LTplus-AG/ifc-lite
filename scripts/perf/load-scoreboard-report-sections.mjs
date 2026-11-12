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
    const state = known.length < rows.length ? 'UNKNOWN on some samples' : active === 0 ? 'none' : active === known.length ? 'ALL' : 'MIXED';
    return `| ${fixture} | ${lane} | ${side} | ${rows.length} | ${active} | ${state} | ${frames.length ? Math.round(median(frames)) : '—'} |`;
  });
}

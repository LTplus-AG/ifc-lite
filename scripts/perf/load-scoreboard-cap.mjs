/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Capped timing (SLOT-RULES "Capped timing, 2026-11-13"): a timed unit may run inside a window in which other work's
 * CPU is limited with cgroup `cpu.max` (host tool `cap.py run ... -- run-scoreboard.sh ...`, which exports
 * LOAD_SCOREBOARD_CAP_STATE = its state file). Inside such a window the host-wide CPU pressure counts the capped
 * groups' own waiting (27-60 % avg10 in every capped sample, proof2 2026-11-13), so it says nothing about the
 * benchmark. There the under-load flag means "the benchmark itself was starved": the share of the sample during which
 * a task of the benchmark (its job cgroup, plus its browser process's own scope) waited for a CPU, and builder
 * processes only in cgroups the cap did not cap. A sample only partly inside a window is flagged. Outside a window
 * nothing changes.
 */

import { readFileSync } from 'node:fs';

/** The cap window state (null without a window; { error } when unreadable, which is never quiet). */
export function readCapState(path = process.env.LOAD_SCOREBOARD_CAP_STATE) {
  if (!path) return null;
  try {
    const s = JSON.parse(readFileSync(path, 'utf8'));
    return {
      id: s.id ?? null, allowanceCores: Number.isFinite(s.cores) ? s.cores : null,
      appliedMs: Number.isFinite(s.appliedEpoch) ? s.appliedEpoch * 1000 : null,
      restoredMs: Number.isFinite(s.restoredEpoch) ? s.restoredEpoch * 1000 : s.restoredAt ? Date.parse(s.restoredAt) : null,
      cappedPaths: (s.entries ?? []).filter((e) => e.new).map((e) => e.path),
    };
  } catch (err) {
    return { error: String(err?.message ?? err).slice(0, 200) };
  }
}

/** Whether the window was open (applied, not yet restored) at `atMs`. */
export function capActive(st, atMs) {
  return Boolean(st && !st.error && st.appliedMs !== null && st.appliedMs <= atMs && (st.restoredMs === null || st.restoredMs > atMs));
}

/** 'none' | 'inside' | 'partial' for a sample from startMs to endMs, from the state read at its start and at its end. */
export function capWindowOf(before, after, startMs, endMs) {
  if (!before && !after) return 'none';
  if (before?.error || after?.error) return 'partial'; // unreadable state is never quiet
  const atStart = capActive(before, startMs), atEnd = capActive(after, endMs);
  if (!atStart && !atEnd) return 'none';
  return atStart && atEnd && before.id === after.id ? 'inside' : 'partial';
}

/** `some` line of a cgroup's cpu.pressure: { avg10 (%), totalUs }, or null when unreadable. */
export function cgroupPressure(cgroup, root = '/sys/fs/cgroup') {
  try {
    const line = readFileSync(`${root}${cgroup}/cpu.pressure`, 'utf8').split('\n').find((l) => l.startsWith('some'));
    const avg10 = Number(/avg10=([\d.]+)/.exec(line)?.[1]), totalUs = Number(/total=(\d+)/.exec(line)?.[1]);
    return Number.isFinite(avg10) && Number.isFinite(totalUs) ? { avg10, totalUs } : null;
  } catch { return null; }
}

/** Whether `cgroup` is one of the capped cgroups or inside one. */
export function isCapped(cgroup, cappedPaths) {
  return (cappedPaths ?? []).some((p) => cgroup === p || cgroup.startsWith(`${p}/`));
}

/**
 * Under-load decision for a sample taken in a cap window. `ownStallPct`: % of the sample during which a benchmark task
 * waited for a CPU (null = unreadable, never quiet). `builderCpuMs`: CPU per builder cgroup during the sample; only
 * cgroups the cap did not cap count (a capped builder is bounded by the allowance). `window` 'partial' always flags.
 */
export function classifyCappedLoad({ window, ownStallPct, limit = 5, builders = [], builderCpuMs = {}, cappedPaths = [], cpuMsLimit = 100 }) {
  const uncapped = Object.entries(builderCpuMs).filter(([c]) => !isCapped(c, cappedPaths));
  const busyGroups = uncapped.filter(([, ms]) => ms === null || ms > cpuMsLimit).map(([c]) => c);
  const starved = !Number.isFinite(ownStallPct) || !(ownStallPct < limit); // null is unreadable, never quiet
  const partial = window !== 'inside';
  const underLoad = partial || starved || busyGroups.length > 0;
  const builderState = builders.length === 0 ? 'none' : busyGroups.length ? 'busy' : uncapped.length ? 'seen, idle' : 'capped';
  return { underLoad, builderState, busyGroups,
    reason: partial ? 'sample only partly inside the cap window'
      : starved ? (ownStallPct === null ? 'benchmark CPU pressure unreadable in the cap window' : `benchmark tasks waited for a CPU ${ownStallPct.toFixed(1)}% of the sample (>= ${limit}) in the cap window`)
        : busyGroups.length ? `uncapped builder cgroup(s) ${busyGroups.join(',')} used > ${cpuMsLimit} ms CPU during the sample` : null };
}

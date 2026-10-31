/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Linux-only /proc sampler for the #7955 retained qualification (PLAN.md,
// "Native memory"): poll ONLY the descendants of one root process (and, for a
// browser, the processes whose command line names its private profile) for
// VmRSS/VmHWM and, optionally, Pss. Never reads or signals foreign processes.
// Sampling can miss short-lived processes; rows say so.

import { existsSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { basename } from 'node:path';

const read = path => { try { return readFileSync(path, 'utf8'); } catch { return null; } };
const kib = (text, key) => { const m = text?.match(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm')); return m ? Number(m[1]) : null; };

/** Chrome rewrites its process title, so match on the NUL-separated command line. */
export function commandLine(pid) {
  const raw = read(`/proc/${pid}/cmdline`);
  return raw === null ? null : raw.split('\0').filter(Boolean);
}

export function children(pid) {
  let out = [];
  try {
    for (const task of readdirSync(`/proc/${pid}/task`)) {
      const text = read(`/proc/${pid}/task/${task}/children`);
      if (text) out = out.concat(text.split(/\s+/).filter(Boolean).map(Number));
    }
  } catch { /* exited between reads */ }
  return out;
}

/** `root` and all its descendants that still exist. */
export function processSet(root) {
  const seen = new Set(), todo = [root];
  while (todo.length) {
    const pid = todo.pop();
    if (seen.has(pid) || !existsSync(`/proc/${pid}`)) continue;
    seen.add(pid);
    todo.push(...children(pid));
  }
  return [...seen];
}

/** The browser's main process: names the private profile and is not a `--type=` child. */
export function findProfileRoot(profileDir) {
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const argv = commandLine(entry);
    if (argv?.includes(`--user-data-dir=${profileDir}`) && !argv.some(a => a.startsWith('--type='))) return Number(entry);
  }
  return null;
}

export function readProcess(pid, withPss) {
  const status = read(`/proc/${pid}/status`);
  if (!status) return null;
  let exe = null;
  try { exe = basename(readlinkSync(`/proc/${pid}/exe`)); } catch { /* not ours to read */ }
  const type = commandLine(pid)?.find(a => a.startsWith('--type='))?.slice(7) ?? null;
  return { pid, exe, type, rssKiB: kib(status, 'VmRSS'), hwmKiB: kib(status, 'VmHWM'),
    pssKiB: withPss ? kib(read(`/proc/${pid}/smaps_rollup`), 'Pss') : null };
}

/**
 * Start sampling the tree under `root` (or, with `root` null, under the browser whose
 * command line names `profileDir`). `include(info)` selects which processes count (e.g. the SMLib
 * worker executable only). `stop()` takes a final sample, then returns the summary.
 */
export function startSampler(root, { intervalMs = 50, profileDir, include = () => true, pss = false } = {}) {
  const peaks = new Map();
  let rootPid = root ?? null;
  let samples = 0, maxConcurrentRssKiB = 0, maxConcurrentPssKiB = 0, running = true, timer;
  const sample = () => {
    let rss = 0, pssSum = 0, anyPss = false;
    if (rootPid === null && profileDir) rootPid = findProfileRoot(profileDir);
    for (const pid of rootPid === null ? [] : processSet(rootPid)) {
      const info = readProcess(pid, pss);
      if (!info || !include(info)) continue;
      const peak = peaks.get(pid) ?? { exe: info.exe, type: info.type, hwmKiB: 0, peakRssKiB: 0, peakPssKiB: null };
      peak.hwmKiB = Math.max(peak.hwmKiB, info.hwmKiB ?? 0);
      peak.peakRssKiB = Math.max(peak.peakRssKiB, info.rssKiB ?? 0);
      if (info.pssKiB !== null) peak.peakPssKiB = Math.max(peak.peakPssKiB ?? 0, info.pssKiB);
      peaks.set(pid, peak);
      rss += info.rssKiB ?? 0;
      if (info.pssKiB !== null) { pssSum += info.pssKiB; anyPss = true; }
    }
    samples++;
    maxConcurrentRssKiB = Math.max(maxConcurrentRssKiB, rss);
    if (anyPss) maxConcurrentPssKiB = Math.max(maxConcurrentPssKiB, pssSum);
  };
  const tick = () => { if (!running) return; sample(); timer = setTimeout(tick, intervalMs); };
  tick();
  return {
    stop() {
      running = false;
      clearTimeout(timer);
      sample();
      const rows = [...peaks.values()];
      const hwm = rows.map(p => p.hwmKiB);
      return { samples, intervalMs, processes: peaks.size, byPid: Object.fromEntries(peaks),
        maxIndividualHwmKiB: hwm.length ? Math.max(...hwm) : null,
        maxObservedConcurrentRssKiB: peaks.size ? maxConcurrentRssKiB : null,
        maxObservedConcurrentPssKiB: pss && peaks.size ? maxConcurrentPssKiB : null,
        caveat: 'sampled descendants only; short-lived processes may be missed; concurrent RSS double-counts shared pages' };
    },
  };
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Linux process and GPU sampling for `scenoptic-bench.mjs`: /proc for Chrome, nvidia-smi for VRAM and clock. */

import { readdirSync, readFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';

export function chromePids(profileDir) {
  const pids = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmd = readFileSync(`/proc/${entry}/cmdline`, 'utf8');
      if (cmd.includes(profileDir)) pids.push(Number(entry));
    } catch { /* process exited between readdir and read */ }
  }
  return pids;
}
export function memoryOf(pids) {
  let rss = 0, pss = 0;
  for (const pid of pids) {
    try {
      const text = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
      rss += Number(/^Rss:\s+(\d+)/m.exec(text)?.[1] ?? 0) * 1024;
      pss += Number(/^Pss:\s+(\d+)/m.exec(text)?.[1] ?? 0) * 1024;
    } catch { /* exited */ }
  }
  return { rssMiB: rss / 2 ** 20, pssMiB: pss / 2 ** 20 };
}
export function vramOf(pids) {
  try {
    const text = execFileSync('nvidia-smi', ['-q', '-d', 'PIDS'], { encoding: 'utf8' });
    let total = null;
    for (const block of text.split(/Process ID\s*:/).slice(1)) {
      const pid = Number(block.trim().split(/\s/)[0]);
      const mib = Number(/Used GPU Memory\s*:\s*(\d+)\s*MiB/.exec(block)?.[1] ?? NaN);
      if (pids.includes(pid) && Number.isFinite(mib)) total = (total ?? 0) + mib;
    }
    return total;
  } catch (err) {
    console.warn('nvidia-smi failed', err.message);
    return null;
  }
}
export const TICK = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim());
export function cpuTicks(pids) {
  let ticks = 0;
  for (const pid of pids) {
    try {
      const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
      ticks += Number(fields[11]) + Number(fields[12]); // utime + stime
    } catch { /* exited */ }
  }
  return ticks;
}

/** Wait for post-load background work (cache writes, source compaction) to end; returns its CPU seconds. */
export async function settleCpu(profileDir, quietCores = 0.5, timeoutMs = 60_000) {
  const pids = chromePids(profileDir);
  const start = Date.now(), ticks0 = cpuTicks(pids);
  let last = ticks0, quiet = 0;
  while (quiet < 3 && Date.now() - start < timeoutMs) {
    await new Promise((res) => setTimeout(res, 500));
    const now = cpuTicks(pids);
    quiet = (now - last) / TICK / 0.5 < quietCores ? quiet + 1 : 0;
    last = now;
  }
  return { cpuSeconds: (last - ticks0) / TICK, wallMs: Date.now() - start };
}

/** Sample the graphics clock during `fn`. Timer queries move with DVFS, so ms alone do not compare across runs. */
export async function withGpuClock(fn) {
  const child = spawn('nvidia-smi', ['--query-gpu=clocks.gr', '--format=csv,noheader,nounits', '-lms', '250'], { stdio: ['ignore', 'pipe', 'ignore'] });
  let text = '';
  child.stdout.on('data', (d) => { text += d; });
  child.on('error', () => {});
  try { return { result: await fn(), mhz: () => {
    const v = text.split('\n').map(Number).filter((n) => n > 0);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  } }; } finally { child.kill(); }
}
